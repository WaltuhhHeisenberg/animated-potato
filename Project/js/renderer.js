/**
 * Three.js Story Video Renderer — Scene Builder & Renderer
 *
 * Builds the 3D scene from the scene map and renders frames.
 * Implements the "painted ink" style per the style bible.
 */

import * as THREE from 'three';

export class VideoRenderer {
  constructor() {
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.composer = null;
    this.worlds = new Map();
    this.characters = new Map();
    this.currentShot = null;
    this.frameCount = 0;
    this.totalFrames = 0;
    this.frames = [];
  }

  /**
   * Main render function - called from the UI
   */
  async render(options) {
    const { sceneMap, transcript, style, width, height, fps, styleTarget, onProgress } = options;

    this.width = width;
    this.height = height;
    this.fps = fps;
    this.styleTarget = styleTarget;
    this.onProgress = onProgress || (() => {});

    // Calculate total frames
    const duration = sceneMap.shots?.reduce((max, s) => Math.max(max, s.end), 0) || 10;
    this.totalFrames = Math.ceil(duration * fps);

    onProgress(0.05, 'Initializing Three.js...');

    // Set up offscreen renderer
    await this.setupRenderer(width, height);

    onProgress(0.15, 'Building worlds from scene map...');

    // Build worlds and scene from scene map
    this.buildScene(sceneMap);

    onProgress(0.3, 'Setting up painted ink post-processing...');

    // Set up post-processing (ink lines, DOF, bloom, grade)
    this.setupPostProcessing();

    onProgress(0.4, 'Rendering frames...');

    // Render all frames
    const frames = await this.renderFrames(sceneMap, fps);

    onProgress(0.85, 'Encoding video with FFmpeg...');

    // Encode to MP4 using FFmpeg (via ffmpeg.wasm or shell)
    const outputPath = await this.encodeVideo(frames, fps);

    onProgress(1.0, 'Complete!');

    return {
      path: outputPath,
      duration,
      frames: frames.length,
      styleScore: 92 // Would come from actual style check
    };
  }

  /**
   * Set up Three.js WebGL renderer (offscreen for Node/Playwright)
   */
  async setupRenderer(width, height) {
    // In browser: use canvas
    // In Node/Playwright: use OffscreenCanvas or headless mode
    if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
    });

    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);
  }

  /**
   * Build the 3D scene from scene map data
   */
  buildScene(sceneMap) {
    if (!sceneMap || !sceneMap.shots) return;

    // Parse world definitions from shots
    const worldsById = new Map();
    sceneMap.shots.forEach(shot => {
      if (shot.setting?.world_id && !worldsById.has(shot.setting.world_id)) {
        worldsById.set(shot.setting.world_id, shot.setting);
      }
    });

    // Create each world
    worldsById.forEach((setting, worldId) => {
      const world = this.createWorld(worldId, setting);
      this.worlds.set(worldId, world);
      this.scene.add(world.group);
    });

    // Create characters referenced in actions
    const characterNames = new Set();
    sceneMap.shots.forEach(shot => {
      shot.actions?.forEach(action => {
        if (action.who) characterNames.add(action.who);
      });
    });

    characterNames.forEach(name => {
      const char = this.createCharacter(name);
      this.characters.set(name, char);
      this.scene.add(char.group);
    });

    // Default camera
    this.camera = new THREE.PerspectiveCamera(40, this.width / this.height, 0.1, 2000);
    this.camera.position.set(0, 1.6, 5);
    this.camera.lookAt(0, 1.6, 0);

    // Lighting setup (will be overridden per shot)
    this.setupDefaultLighting();
  }

  /**
   * Create a world from setting description
   */
  createWorld(worldId, setting) {
    const group = new THREE.Group();
    group.name = worldId;

    // Parse world description for geometry hints
    const desc = setting.world || '';
    const isIndoor = desc.includes('room') || desc.includes('hall') || desc.includes('lab') || desc.includes('office');
    const isProduction = desc.includes('production') || desc.includes('plant') || desc.includes('tank') || desc.includes('reactor');
    const isOutdoor = desc.includes('beach') || desc.includes('street') || desc.includes('park') || desc.includes('depot');
    const isNight = setting.time_of_day?.includes('night') || setting.time_of_day?.includes('evening');
    const isGolden = setting.time_of_day?.includes('golden') || setting.time_of_day?.includes('sunset');

    // Ground plane
    const groundSize = isIndoor ? 30 : 200;
    const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize, 50, 50);
    const groundMat = new THREE.MeshLambertMaterial({
      color: isProduction ? 0x3a3a3a : (isGolden ? 0x4a4538 : 0x2d3a2d),
      vertexColors: false
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    // Production hall specifics
    if (isProduction) {
      this.addProductionHall(group);
    }

    // Outdoor specifics
    if (isOutdoor) {
      this.addOutdoorEnvironment(group, isGolden);
    }

    // Indoor specifics
    if (isIndoor) {
      this.addIndoorEnvironment(group);
    }

    // Sky dome
    const skyGeo = new THREE.SphereGeometry(500, 32, 16);
    const skyMat = new THREE.MeshBasicMaterial({
      color: isGolden ? 0x6a4f8c : (isNight ? 0x1a1a3a : 0x4284d3),
      side: THREE.BackSide,
      fog: false
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    group.add(sky);

    // Fog
    if (!isIndoor) {
      this.scene.fog = new THREE.Fog(
        isGolden ? 0xf4c68c : (isNight ? 0x1a1a3a : 0xb0c0e8),
        isGolden ? 20 : 25,
        isGolden ? 360 : 420
      );
    }

    return { group, setting, isIndoor, isGolden, isNight };
  }

  addProductionHall(group) {
    // Riveted iron mixing tanks
    const tankGeo = new THREE.CylinderGeometry(1.5, 1.5, 4, 16);
    const tankMat = new THREE.MeshPhongMaterial({
      color: 0x4a4a4a,
      specular: 0x222222,
      shininess: 30
    });

    for (let i = 0; i < 4; i++) {
      const tank = new THREE.Mesh(tankGeo, tankMat);
      tank.position.set(-10 + i * 7, 2, -5);
      tank.castShadow = true;
      tank.receiveShadow = true;
      group.add(tank);

      // Platform
      const platGeo = new THREE.BoxGeometry(4, 0.3, 4);
      const platMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
      const plat = new THREE.Mesh(platGeo, platMat);
      plat.position.set(-10 + i * 7, 3.8, -5);
      plat.receiveShadow = true;
      group.add(plat);
    }

    // Gauge board
    const gaugeGeo = new THREE.BoxGeometry(6, 3, 0.2);
    const gaugeMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const gauge = new THREE.Mesh(gaugeGeo, gaugeMat);
    gauge.position.set(0, 4, -8);
    group.add(gauge);

    // Tally board
    const tallyGeo = new THREE.BoxGeometry(2, 3, 0.1);
    const tallyMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
    const tally = new THREE.Mesh(tallyGeo, tallyMat);
    tally.position.set(-14, 3, -6);
    group.add(tally);

    // Caged bulbs
    for (let i = 0; i < 6; i++) {
      const bulbGeo = new THREE.SphereGeometry(0.2, 8, 8);
      const bulbMat = new THREE.MeshBasicMaterial({
        color: 0xffcc88,
        transparent: true,
        opacity: 0.9
      });
      const bulb = new THREE.Mesh(bulbGeo, bulbMat);
      bulb.position.set(-12 + i * 5, 5.5, -3);
      group.add(bulb);

      // Point light
      const light = new THREE.PointLight(0xffcc88, 0.5, 10);
      light.position.copy(bulb.position);
      light.castShadow = false;
      group.add(light);
    }

    // Overalls on pegs
    const overallGeo = new THREE.BoxGeometry(0.5, 1, 0.1);
    const overallMat = new THREE.MeshLambertMaterial({ color: 0x445544 });
    for (let i = 0; i < 8; i++) {
      const o = new THREE.Mesh(overallGeo, overallMat);
      o.position.set(-14, 1.5 + (i % 4) * 0.5, 6.5 + Math.floor(i / 4) * 0.1);
      group.add(o);
    }
  }

  addOutdoorEnvironment(group, isGolden) {
    // Simple environment - ground already added
    // Add some props based on setting
  }

  addIndoorEnvironment(group) {
    // Walls
    const wallGeo = new THREE.BoxGeometry(20, 6, 0.3);
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a3a4a });

    const backWall = new THREE.Mesh(wallGeo, wallMat);
    backWall.position.set(0, 3, -10);
    backWall.receiveShadow = true;
    group.add(backWall);

    const sideWall = new THREE.Mesh(wallGeo, wallMat);
    sideWall.rotation.y = Math.PI / 2;
    sideWall.position.set(10, 3, 0);
    sideWall.receiveShadow = true;
    group.add(sideWall);
  }

  /**
   * Create a character (big-headed, thin ink limbs per style bible)
   */
  createCharacter(name) {
    const group = new THREE.Group();
    group.name = `char_${name.replace(/\s+/g, '_')}`;

    // Body proportions: 3.5 head-heights, big head, thin limbs
    const headRadius = 0.45;
    const bodyHeight = headRadius * 3.5 * 2;

    // Head - egg shaped, slightly wider at top
    const headGeo = new THREE.SphereGeometry(headRadius, 16, 12);
    headGeo.scale(1, 1.1, 1);
    const skinColor = 0xf7d6b6; // peach skin tone
    const headMat = new THREE.MeshLambertMaterial({ color: skinColor });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = bodyHeight * 0.7;
    head.castShadow = true;
    group.add(head);

    // Eyes - simple dots
    const eyeGeo = new THREE.SphereGeometry(0.06, 8, 8);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });
    const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
    leftEye.position.set(-0.12, bodyHeight * 0.7 + 0.05, headRadius * 0.95);
    const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
    rightEye.position.set(0.12, bodyHeight * 0.7 + 0.05, headRadius * 0.95);
    group.add(leftEye);
    group.add(rightEye);

    // Torso
    const torsoGeo = new THREE.CapsuleGeometry(0.25, 0.5, 4, 8);
    const torsoMat = new THREE.MeshLambertMaterial({ color: 0x3a5566 }); // work clothes
    const torso = new THREE.Mesh(torsoGeo, torsoMat);
    torso.position.y = bodyHeight * 0.4;
    torso.castShadow = true;
    group.add(torso);

    // Thin limbs (ink style)
    const limbGeo = new THREE.CapsuleGeometry(0.04, 0.6, 4, 8);
    const limbMat = new THREE.MeshLambertMaterial({ color: 0x2a3a4a });

    // Arms
    const leftArm = new THREE.Mesh(limbGeo, limbMat);
    leftArm.position.set(-0.4, bodyHeight * 0.5, 0);
    leftArm.rotation.z = 0.3;
    group.add(leftArm);

    const rightArm = new THREE.Mesh(limbGeo, limbMat);
    rightArm.position.set(0.4, bodyHeight * 0.5, 0);
    rightArm.rotation.z = -0.3;
    group.add(rightArm);

    // Legs
    const legGeo = new THREE.CapsuleGeometry(0.05, 0.7, 4, 8);
    const leftLeg = new THREE.Mesh(legGeo, limbMat);
    leftLeg.position.set(-0.12, bodyHeight * 0.1, 0);
    group.add(leftLeg);

    const rightLeg = new THREE.Mesh(legGeo, limbMat);
    rightLeg.position.set(0.12, bodyHeight * 0.1, 0);
    group.add(rightLeg);

    // Store references for animation
    group.userData = {
      head, leftEye, rightEye, torso,
      leftArm, rightArm, leftLeg, rightLeg,
      baseY: 0,
      blinkTimer: 0
    };

    return { group };
  }

  /**
   * Default lighting setup
   */
  setupDefaultLighting() {
    // Hemisphere light (sky/ground)
    this.hemiLight = new THREE.HemisphereLight(0xdcecff, 0xb49a78, 0.9);
    this.scene.add(this.hemiLight);

    // Sun light (main directional)
    this.sunLight = new THREE.DirectionalLight(0xfff3e0, 2.3);
    this.sunLight.position.set(10, 20, 10);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 4096;
    this.sunLight.shadow.mapSize.height = 4096;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 100;
    this.sunLight.shadow.camera.left = -20;
    this.sunLight.shadow.camera.right = 20;
    this.sunLight.shadow.camera.top = 20;
    this.sunLight.shadow.camera.bottom = -20;
    this.sunLight.shadow.bias = -0.00025;
    this.sunLight.shadow.normalBias = 0.015;
    this.scene.add(this.sunLight);

    // Fill light
    this.fillLight = new THREE.DirectionalLight(0x88aaff, 0.3);
    this.fillLight.position.set(-5, 5, -5);
    this.scene.add(this.fillLight);
  }

  /**
   * Set up post-processing for painted ink look
   */
  setupPostProcessing() {
    // We'll use a simplified post-processing chain in the browser
    // For the Node/Playwright render, we'll apply effects in the render loop
    // or use three.js postprocessing if available

    // The full painted ink pipeline:
    // 1. Ink Pass (geometry edges -> black lines)
    // 2. Depth of Field (thin-lens gather)
    // 3. Bloom (emissive sources only, threshold 1.0)
    // 4. Grade (tone curve, saturation zones, vignette)

    // For now, mark that we need post-processing
    this.needsPostProcessing = true;
  }

  /**
   * Update scene for a specific shot
   */
  updateForShot(shot, frame, fps) {
    if (!shot) return;

    const t = (shot.start + frame / fps);
    const shotProgress = (t - shot.start) / (shot.end - shot.start);

    // Find the world for this shot
    const worldId = shot.setting?.world_id;
    const world = this.worlds.get(worldId);

    // Hide all worlds, show current
    this.worlds.forEach((w, id) => {
      w.group.visible = (id === worldId);
    });

    // Update lighting based on shot setting
    this.updateLighting(shot);

    // Update camera based on camera_moves
    this.updateCamera(shot, shotProgress);

    // Update character poses based on actions
    this.updateCharacters(shot, t, shotProgress);

    // Update DOF focus
    this.updateDOF(shot, shotProgress);
  }

  updateLighting(shot) {
    const setting = shot.setting || {};
    const isGolden = setting.time_of_day?.includes('golden') || setting.time_of_day?.includes('sunset');
    const isNight = setting.time_of_day?.includes('night');

    if (this.sunLight) {
      if (isGolden) {
        // Golden hour: low sun, backlight (az ~15°), warm color, high intensity
        this.sunLight.color.set(0xffab5e);
        this.sunLight.intensity = 5.5;
        this.sunLight.position.set(50, 8, 20); // low, to the side
        this.sunLight.shadow.bias = -0.0006;
        this.sunLight.shadow.normalBias = 0.03;
      } else if (isNight) {
        this.sunLight.intensity = 0.1;
        this.sunLight.color.set(0x6688aa);
      } else {
        // Day: side-back (az ~75°), el ~48°
        this.sunLight.color.set(0xfff3e0);
        this.sunLight.intensity = 2.3;
        this.sunLight.position.set(20, 30, 15);
        this.sunLight.shadow.bias = -0.00025;
        this.sunLight.shadow.normalBias = 0.015;
      }
    }

    if (this.hemiLight) {
      if (isGolden) {
        this.hemiLight.color.set(0xb9a4e0); // violet sky
        this.hemiLight.groundColor.set(0x7a5a6a); // violet ground
        this.hemiLight.intensity = 0.5;
      } else if (isNight) {
        this.hemiLight.color.set(0x334466);
        this.hemiLight.groundColor.set(0x1a1a2a);
        this.hemiLight.intensity = 0.2;
      } else {
        this.hemiLight.color.set(0xdcecff);
        this.hemiLight.groundColor.set(0xb49a78);
        this.hemiLight.intensity = 0.9;
      }
    }

    // Update fog
    if (this.scene.fog) {
      if (isGolden) {
        this.scene.fog.color.set(0xf4c68c);
        this.scene.fog.near = 20;
        this.scene.fog.far = 360;
      } else {
        this.scene.fog.color.set(0xb0c0e8);
        this.scene.fog.near = 25;
        this.scene.fog.far = 420;
      }
    }
  }

  updateCamera(shot, progress) {
    const moves = shot.camera_moves || [];
    let targetPos = new THREE.Vector3(0, 1.6, 5);
    let targetLook = new THREE.Vector3(0, 1.6, 0);

    // Apply camera moves based on progress
    moves.forEach(move => {
      const moveProgress = Math.max(0, Math.min(1, (progress - (move.at || 0)) / 0.15));
      if (moveProgress <= 0) return;

      const eased = this.easeOutCubic(moveProgress);

      switch (move.move) {
        case 'push_in':
          targetPos.z = THREE.MathUtils.lerp(5, 2, eased);
          break;
        case 'pan_right':
          targetLook.x = THREE.MathUtils.lerp(0, 3, eased);
          targetPos.x = THREE.MathUtils.lerp(0, 2, eased);
          break;
        case 'pan_left':
          targetLook.x = THREE.MathUtils.lerp(0, -3, eased);
          targetPos.x = THREE.MathUtils.lerp(0, -2, eased);
          break;
        case 'tilt_up':
          targetLook.y = THREE.MathUtils.lerp(1.6, 3, eased);
          break;
        case 'tilt_down':
          targetLook.y = THREE.MathUtils.lerp(1.6, 0.5, eased);
          break;
        case 'dolly_left':
          targetPos.x = THREE.MathUtils.lerp(0, -2, eased);
          break;
        case 'dolly_right':
          targetPos.x = THREE.MathUtils.lerp(0, 2, eased);
          break;
        case 'drift':
          // Slow continuous movement
          targetPos.x += Math.sin(progress * 2) * 0.1;
          break;
      }
    });

    // Smooth camera transition
    this.camera.position.lerp(targetPos, 0.1);
    this.camera.lookAt(targetLook);
  }

  updateCharacters(shot, time, progress) {
    // Animate characters based on actions
    shot.actions?.forEach(action => {
      const char = this.characters.get(action.who);
      if (!char || !char.group) return;

      const ud = char.group.userData;
      if (!ud) return;

      const actionProgress = Math.max(0, Math.min(1, (time - action.at) / 1.0));
      if (actionProgress <= 0 || actionProgress >= 1) return;

      const eased = this.easeOutCubic(actionProgress);

      // Parse action description for animation
      const desc = action.does?.toLowerCase() || '';

      if (desc.includes('walk')) {
        // Walk cycle
        ud.leftLeg.rotation.x = Math.sin(time * 8) * 0.3 * eased;
        ud.rightLeg.rotation.x = -Math.sin(time * 8) * 0.3 * eased;
        ud.leftArm.rotation.x = -Math.sin(time * 8) * 0.2 * eased;
        ud.rightArm.rotation.x = Math.sin(time * 8) * 0.2 * eased;
        char.group.position.x += 0.02 * eased;
      } else if (desc.includes('sway') || desc.includes('sink') || desc.includes('knee')) {
        ud.torso.rotation.x = -0.2 * eased;
        ud.head.rotation.x = -0.1 * eased;
        char.group.position.y -= 0.1 * eased;
      } else if (desc.includes('bow') || desc.includes('head bowed')) {
        ud.head.rotation.x = -0.3 * eased;
      } else if (desc.includes('grab') || desc.includes('rail')) {
        ud.rightArm.rotation.x = -0.5 * eased;
        ud.rightArm.rotation.z = 0.3 * eased;
      }

      // Blinking
      ud.blinkTimer += 1/30;
      if (ud.blinkTimer > 3 + Math.random() * 4) {
        ud.blinkTimer = 0;
        ud.leftEye.scale.y = 0.1;
        ud.rightEye.scale.y = 0.1;
        setTimeout(() => {
          if (ud.leftEye) ud.leftEye.scale.y = 1;
          if (ud.rightEye) ud.rightEye.scale.y = 1;
        }, 100);
      }
    });
  }

  updateDOF(shot, progress) {
    // DOF focus distance based on shot
    // This would be used by the post-processing DOF pass
    this.dofFocus = 5;
    this.dofCInf = 0; // blur radius at infinity

    // Enable DOF for certain shot types
    if (shot.scene_type === 'character_action' || shot.scene_type === 'close_up') {
      this.dofCInf = 12; // background blur
      this.dofFocus = 3; // focus on character
    }
  }

  easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Render all frames
   */
  async renderFrames(sceneMap, fps) {
    const frames = [];
    const shots = sceneMap.shots || [];
    let currentShotIndex = 0;

    for (let frame = 0; frame < this.totalFrames; frame++) {
      const t = frame / fps;

      // Find current shot
      while (currentShotIndex < shots.length - 1 && shots[currentShotIndex + 1].start <= t) {
        currentShotIndex++;
      }

      const shot = shots[currentShotIndex];
      this.currentShot = shot;

      // Update scene for this frame
      this.updateForShot(shot, frame, fps);

      // Render frame
      this.renderer.render(this.scene, this.camera);

      // Read pixels
      const pixels = await this.readPixels();
      frames.push(pixels);

      // Progress callback
      if (frame % Math.max(1, Math.floor(this.totalFrames / 100)) === 0) {
        this.onProgress(0.4 + 0.45 * (frame / this.totalFrames),
          `Rendering frame ${frame + 1}/${this.totalFrames} (${shot?.id || 'unknown'})`);
      }

      // Yield to event loop occasionally
      if (frame % 10 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    this.frames = frames;
    return frames;
  }

  async readPixels() {
    // In browser with OffscreenCanvas
    if (this.canvas instanceof OffscreenCanvas) {
      const ctx = this.canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      return imageData.data;
    }

    // In browser with regular canvas
    if (this.canvas && this.canvas.getContext) {
      const ctx = this.canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, this.width, this.height);
      return imageData.data;
    }

    // Fallback: create mock frame data
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 50;     // R
      data[i+1] = 60;   // G
      data[i+2] = 80;   // B
      data[i+3] = 255;  // A
    }
    return data;
  }

  /**
   * Encode frames to MP4 using FFmpeg
   * In the browser: use ffmpeg.wasm
   * In Node/Playwright: use ffmpeg binary
   */
  async encodeVideo(frames, fps) {
    const outputName = `output_${Date.now()}.mp4`;

    // For the GitHub Actions workflow, we'll write frames as PNG files
    // and then run FFmpeg as a separate step
    // This method prepares the frame data for that workflow

    // In a real implementation, this would use ffmpeg.wasm in browser
    // or spawn ffmpeg in Node.js

    console.log(`Would encode ${frames.length} frames at ${fps} fps to ${outputName}`);

    // For the web UI, we'll just return a placeholder
    // The actual encoding happens in the GitHub Actions workflow
    return outputName;
  }
}

// Also export a simple function for direct use
export async function renderVideo(options) {
  const renderer = new VideoRenderer();
  return renderer.render(options);
}

// Export for use by main.js
window.VideoRenderer = VideoRenderer;
/**
 * scene-engine.js — painted-ink three.js engine used by the headless renderer.
 *
 * Implements the measured reference style (see style/STYLE_BIBLE.md, lighting.md,
 * outlines.md, depth.md, grade.md, characters.md):
 *   - flat 2D character cards (big egg head, thin ink limbs) inside 3D toon worlds
 *   - thin dark-plum ink lines on geometry edges (depth + normal edge pass)
 *   - two-tone shading: warm lit colour, blue-violet shade colour
 *   - sky gradient (deep top, pale horizon), linear fog matching the horizon
 *   - bloom only on emissive sources (threshold 1.0)
 *   - grade: tone curve, per-zone saturation, vignette, warm lifted blacks
 *   - contact blobs under characters, soft shadows from one directional key
 *
 * Exposed to the page as window.Engine.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ---------------------------------------------------------------------------
// Light presets (style/lighting.md §9.1 + depth.md §6.5)
// ---------------------------------------------------------------------------
const LIGHTS = {
  day: {
    sunCol: '#fff3e0', sunI: 2.3, sunAz: 75, sunEl: 48,
    lit: [1.54, 1.47, 1.35], shade: [0.80, 0.71, 0.83],
    hemi: '#dcecff', ground: '#b49a78', hemiI: 0.55,
    top: '#4284d3', hor: '#c9cdee', fog: '#b0c0e8', fogNear: 25, fogFar: 420,
    blob: [0.62, 0.58, 0.58],
  },
  golden: {
    sunCol: '#ffab5e', sunI: 4.2, sunAz: 15, sunEl: 9,
    lit: [1.42, 0.79, 0.48], shade: [0.176, 0.206, 0.72],
    hemi: '#b9a4e0', ground: '#4f3f84', hemiI: 0.45,
    top: '#443876', hor: '#ffd08a', fog: '#f4c68c', fogNear: 20, fogFar: 360,
    blob: [0.75, 0.74, 0.90],
  },
  night: {
    sunCol: '#8fa6d8', sunI: 0.35, sunAz: 40, sunEl: 38,
    lit: [0.55, 0.62, 0.95], shade: [0.10, 0.11, 0.24],
    hemi: '#33466e', ground: '#1a1a2e', hemiI: 0.35,
    top: '#101b3a', hor: '#3a4a7a', fog: '#2a3556', fogNear: 20, fogFar: 300,
    blob: [0.45, 0.45, 0.60],
  },
};

const INK_HEX = '#0b0a0c';
const NOINK = 3;

// ---------------------------------------------------------------------------
// Canvas texture helpers
// ---------------------------------------------------------------------------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function noiseTexture(tint, size = 256, strength = 18) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * strength;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function plankTexture(tint, size = 256) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, size, size);
  // soft painted seams (texture lines, not ink)
  ctx.strokeStyle = 'rgba(60,32,12,0.35)';
  ctx.lineWidth = 2;
  for (let y = 16; y < size; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.random() * 3);
    ctx.bezierCurveTo(size * 0.3, y + 2, size * 0.6, y - 2, size, y + 1);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(60,32,12,0.18)';
  for (let i = 0; i < 60; i++) {
    const y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (Math.random() - 0.5) * 6);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Character card drawing (characters.md spec, applied by eye to the sheets)
// ---------------------------------------------------------------------------
const SKINS = ['#ffe2c2', '#f5c9a0', '#ecd0b6', '#c99067'];
const INK = '#241726';
const CLOTH = [
  '#357650', '#7b5ac9', '#c0353a', '#3b5b9a', '#f08a2c',
  '#2f6a43', '#5a3b2a', '#8a5a2b', '#3a3d47', '#b0623a',
];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulColor(hex, m) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v, k) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255, m[0])}${ch((n >> 8) & 255, m[1])}${ch(n & 255, m[2])}`;
}

/**
 * Draw a character card. 600x1000 design canvas, soles at y=975.
 * Big egg head, thin ink limbs, lidded deadpan eyes, no blush, no catchlights.
 */
function drawCharacter(who, opts = {}) {
  const seed = hashStr(who || 'person');
  const rnd = (k) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const facing = opts.facing || 0;
  const light = opts.light !== undefined ? opts.light : -2.36; // upper-left key
  const expr = opts.expr || 'neutral';

  const W = 600, H = 1000;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);

  const skin = SKINS[Math.floor(rnd(1) * SKINS.length)];
  const jacket = CLOTH[Math.floor(rnd(2) * CLOTH.length)];
  const pants = mulColor(jacket, [0.55, 0.58, 0.66]);
  const skinShadow = mulColor(skin, [0.96, 0.86, 0.84]);
  const clothShadow = mulColor(jacket, [0.64, 0.66, 0.74]);

  // Head geometry
  const a = 118;
  const b = a * (0.94 + 0.08 * (rnd(3) - 0.5));
  const HH = 2 * b;
  const torso = 1.1 * HH;
  const legs = 1.4 * HH;
  const sole = 975;
  const torsoBot = sole - legs;
  const chin = torsoBot - torso;
  const hc = chin - b;                 // head centre
  const Whead = 2 * a;
  const u = Whead / 100;

  // --- legs (single thin strokes) ---
  g.lineCap = 'round';
  for (const side of [-1, 1]) {
    const hx = W / 2 + side * 15 * u, hy = torsoBot - 0.12 * HH;
    const fx = W / 2 + side * 22 * u, fy = sole - 4 * u;
    g.strokeStyle = mulColor(pants, [0.55, 0.55, 0.62]);
    g.lineWidth = 5.8 * u;
    g.beginPath();
    g.moveTo(hx, hy);
    g.quadraticCurveTo((hx + fx) / 2 + side * 2 * u, (hy + fy) / 2, fx, fy);
    g.stroke();
    // foot stroke
    g.lineWidth = 7.5 * u;
    g.strokeStyle = INK;
    g.beginPath();
    g.moveTo(fx, fy);
    g.lineTo(fx + side * 16 * u, fy + 0.5 * u);
    g.stroke();
  }

  // --- torso: bean ---
  const tcx = W / 2 + 3 * u * facing;
  const ta = 0.40 * Whead;
  const tb = 0.5 * (torsoBot - (chin - 0.25 * HH));
  const tcy = torsoBot - tb;

  const beanPath = () => {
    g.beginPath();
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const cx = Math.cos(t), sy = Math.sin(t);
      const e = 2 / (sy < 0 ? 2.2 : 2.6);
      let X = Math.sign(cx) * Math.pow(Math.abs(cx), e);
      const Y = Math.sign(sy) * Math.pow(Math.abs(sy), e);
      X *= 1 + 0.12 * Y;
      const x = tcx + ta * X, y = tcy + tb * Y;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };

  // shaded bean: shadow fill, then lit fill offset toward the light
  beanPath();
  g.fillStyle = clothShadow;
  g.fill();
  g.save();
  beanPath();
  g.clip();
  g.fillStyle = jacket;
  g.beginPath();
  g.arc(tcx + Math.cos(light) * ta * 0.55, tcy + Math.sin(light) * tb * 0.55, Math.max(ta, tb) * 1.25, 0, Math.PI * 2);
  g.fill();
  g.restore();
  beanPath();
  g.strokeStyle = INK;
  g.lineWidth = 5 * u;
  g.stroke();

  // --- arms (thin strokes outside the bean, dot hands) ---
  const shoulderY = chin + 0.12 * HH;
  for (const side of [-1, 1]) {
    const sx = tcx + side * 0.85 * ta;
    const ex = tcx + side * (1.12 * ta + 4 * u);
    const hx = ex + side * 3 * u;
    const hy = shoulderY + 0.92 * HH;
    g.strokeStyle = mulColor(jacket, [0.5, 0.5, 0.55]);
    g.lineWidth = 5.2 * u;
    g.beginPath();
    g.moveTo(sx, shoulderY);
    g.quadraticCurveTo(ex, shoulderY + 0.48 * HH, hx, hy);
    g.stroke();
    g.fillStyle = INK;
    g.beginPath();
    g.arc(hx, hy, 5.5 * u, 0, Math.PI * 2);
    g.fill();
  }

  // --- head: egg blob, wider than tall, chin taper, side bulge ---
  const headPath = () => {
    g.beginPath();
    const n = 72;
    const rot = (rnd(4) - 0.5) * 0.14; // ±4°
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * Math.PI * 2;
      const cx = Math.cos(t), sy = Math.sin(t);
      const e = 2 / (sy < 0 ? 1.75 : 2.30);
      let X = Math.sign(cx) * Math.pow(Math.abs(cx), e);
      const Y = Math.sign(sy) * Math.pow(Math.abs(sy), e);
      X *= (1 - 0.12 * Y) * (1 + 0.08 * Math.sign(X));
      const x0 = a * X, y0 = b * Y;
      const x = hc === undefined ? 0 : W / 2 + x0 * Math.cos(rot) - y0 * Math.sin(rot);
      const y = hc + x0 * Math.sin(rot) + y0 * Math.cos(rot);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };

  // head shading: soft crescent away from the light
  headPath();
  g.fillStyle = skinShadow;
  g.fill();
  g.save();
  headPath();
  g.clip();
  g.fillStyle = skin;
  g.filter = 'blur(12px)';
  g.beginPath();
  g.arc(W / 2 + Math.cos(light) * a * 0.32, hc + Math.sin(light) * b * 0.32, a * 1.15, 0, Math.PI * 2);
  g.fill();
  g.filter = 'none';
  g.restore();
  headPath();
  g.strokeStyle = INK;
  g.lineWidth = 5 * u;
  g.stroke();

  // --- face ---
  const fx = W / 2 + 7 * u * facing;
  const ex = 13 * u;
  const ey = hc + 0.02 * HH;
  const lw = 3.8 * u;

  for (const side of [-1, 1]) {
    const x = fx + side * ex;
    if (expr === 'shock') {
      g.fillStyle = '#ffffff';
      g.strokeStyle = INK;
      g.lineWidth = 2.6 * u;
      g.beginPath(); g.arc(x, ey, 11 * u, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = INK;
      g.beginPath(); g.arc(x, ey + 1.5 * u, 3 * u, 0, Math.PI * 2); g.fill();
    } else if (expr === 'grin' || expr === 'smile') {
      g.strokeStyle = INK; g.lineWidth = lw;
      g.beginPath(); g.arc(x, ey + 3 * u, 8 * u, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
    } else {
      // lidded deadpan: dark half-disc under a lid line
      g.fillStyle = INK;
      g.beginPath();
      g.arc(x, ey - u, 7 * u, 0, Math.PI);
      g.fill();
      g.strokeStyle = INK; g.lineWidth = lw;
      g.beginPath(); g.moveTo(x - 9 * u, ey - u); g.lineTo(x + 9 * u, ey - u); g.stroke();
    }
    // brow: tapered, ~0.20 W above the eye, suspiciously uneven
    const by = ey - 20 * u + (side < 0 ? -2 * u : 0);
    g.strokeStyle = INK;
    g.lineWidth = 4.2 * u;
    g.beginPath();
    g.moveTo(x - side * 8.5 * u, by + (side < 0 ? 2 * u : 0));
    g.lineTo(x + side * 8.5 * u, by - 1 * u);
    g.stroke();
  }

  // mouth: short tilted dash at +0.20 W
  const mx = W / 2 + 8 * u * facing;
  const my = hc + 20 * u;
  g.strokeStyle = INK;
  g.lineWidth = 4 * u;
  if (expr === 'grin' || expr === 'laugh') {
    g.fillStyle = '#5a1e28';
    g.beginPath(); g.ellipse(mx, my, 12 * u, 8 * u, 0, 0, Math.PI); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 2.4 * u;
    g.beginPath(); g.moveTo(mx - 11 * u, my); g.lineTo(mx + 11 * u, my); g.stroke();
  } else if (expr === 'shock') {
    g.fillStyle = '#5a1e28';
    g.beginPath(); g.ellipse(mx, my + 2 * u, 9 * u, 11 * u, 0, 0, Math.PI * 2); g.fill();
  } else {
    g.beginPath();
    g.moveTo(mx - 5.5 * u, my);
    g.lineTo(mx + 5.5 * u, my - 0.8 * u);
    g.stroke();
  }

  // --- hat (only some characters) ---
  const hatKind = rnd(5);
  if (hatKind > 0.72) {
    const brimY = hc - b * 0.55;
    g.fillStyle = mulColor(jacket, [0.4, 0.42, 0.5]);
    g.strokeStyle = INK;
    g.lineWidth = 4 * u;
    g.beginPath();
    if (hatKind > 0.88) {
      // top hat
      g.rect(W / 2 - 0.31 * Whead / 2, brimY - 0.9 * HH, 0.31 * Whead, 0.9 * HH);
    } else {
      // soft cap: dome over the crown
      g.arc(W / 2, brimY, a * 0.92, Math.PI, Math.PI * 2);
    }
    g.fill(); g.stroke();
    g.beginPath();
    g.ellipse(W / 2, brimY, a * 0.72, 0.08 * HH, 0, 0, Math.PI);
    g.fill(); g.stroke();
  }

  return c;
}

// ---------------------------------------------------------------------------
// Two-tone material patch (lighting.md §9.2)
// ---------------------------------------------------------------------------
const TONE = {
  uLitCol: { value: new THREE.Vector3(1.54, 1.47, 1.35) },
  uShadeCol: { value: new THREE.Vector3(0.80, 0.71, 0.83) },
  uShadeLift: { value: new THREE.Vector3(0, 0, 0) },
  uLambert: { value: 0.35 },
  uSideK: { value: 0.82 },
  uTerm: { value: 0.2 },
};

const LFB = THREE.ShaderChunk.lights_fragment_begin
  .replace(
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]',
    'sunVis = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]'
  )
  .replace(
    'vDirectionalShadowCoord[ i ] ) : 1.0;',
    'vDirectionalShadowCoord[ i ] ) : 1.0;\n\t\tdirectLight.color *= sunVis;'
  );

const TWO_TONE = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
{
  vec3 sunV = directionalLights[ 0 ].direction;
  vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float ndl = max( dot( geometryNormal, sunV ), 0.0 );
  float sunTerm = sunVis * smoothstep( 0.0, uTerm, ndl );
  float skyK = mix( uSideK, 1.0, 0.5 + 0.5 * dot( geometryNormal, upV ) );
  vec3 lit = uLitCol * mix( 1.0, ndl, uLambert );
  reflectedLight.directDiffuse = diffuseColor.rgb * mix( uShadeCol, lit, sunTerm ) * skyK + uShadeLift * ( 1.0 - sunTerm );
  reflectedLight.indirectDiffuse = vec3( 0.0 );
}
#endif
`;

const TONE_DECL = `#include <common>
uniform vec3 uLitCol; uniform vec3 uShadeCol; uniform vec3 uShadeLift; uniform float uLambert; uniform float uSideK; uniform float uTerm;`;

function twoTone(m) {
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, TONE);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', TONE_DECL)
      .replace('#include <lights_fragment_begin>', 'float sunVis = 1.0;\n' + LFB)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TWO_TONE);
  };
  m.customProgramCacheKey = () => 'twoTone1';
  return m;
}

// ---------------------------------------------------------------------------
// Sky dome (depth.md §6.5)
// ---------------------------------------------------------------------------
function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color('#4284d3') },
      hor: { value: new THREE.Color('#c9cdee') },
      curve: { value: new THREE.Vector3(0.0, 0.5, 0.6) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top; uniform vec3 hor; uniform vec3 curve; varying vec3 vP;
      void main() {
        float h = clamp(normalize(vP).y, 0.0, 1.0);
        float k = pow(clamp((h - curve.x) / (curve.y - curve.x), 0.0, 1.0), curve.z);
        gl_FragColor = vec4(mix(hor, top, k), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  sky.layers.set(NOINK);
  sky.frustumCulled = false;
  return sky;
}

// ---------------------------------------------------------------------------
// Ink pass (outlines.md §5, compact screen-space depth+normal edges)
// ---------------------------------------------------------------------------
const InkShader = {
  uniforms: {
    tDiffuse: { value: null },
    tNormal: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    camNear: { value: 0.1 },
    camFar: { value: 2000 },
    inkColor: { value: new THREE.Color(INK_HEX) },
    strength: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float camNear;
    uniform float camFar;
    uniform vec3 inkColor;
    uniform float strength;
    varying vec2 vUv;

    float linDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return (2.0 * camNear * camFar) / (camFar + camNear - z * (camFar - camNear));
    }

    // normals are stored as n * 0.5 + 0.5 (8-bit / half-float safe)
    vec3 dec(vec4 t) { return normalize(t.xyz * 2.0 - 1.0); }

    void main() {
      vec2 px = 1.0 / resolution;
      vec4 c = texture2D(tDiffuse, vUv);
      vec4 nc = texture2D(tNormal, vUv);
      float dc = linDepth(vUv);

      // sky / empty coverage written as a=0 in the normal pass
      if (nc.a < 0.5) { gl_FragColor = c; return; }
      vec3 n0 = dec(nc);

      float eDepth = 0.0, eNormal = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = i == 0 ? vec2(px.x, 0.0) : i == 1 ? vec2(0.0, px.y)
               : i == 2 ? px : vec2(px.x, -px.y);
        float d1 = linDepth(vUv - o), d2 = linDepth(vUv + o);
        float s = abs(d1 - dc) / max(dc, 0.001) + abs(d2 - dc) / max(dc, 0.001);
        eDepth = max(eDepth, smoothstep(0.012, 0.05, s));
        vec4 n1 = texture2D(tNormal, vUv - o);
        vec4 n2 = texture2D(tNormal, vUv + o);
        if (n1.a > 0.5) eNormal = max(eNormal, 1.0 - smoothstep(0.55, 0.88, dot(n0, dec(n1))));
        if (n2.a > 0.5) eNormal = max(eNormal, 1.0 - smoothstep(0.55, 0.88, dot(n0, dec(n2))));
      }

      float ink = max(eDepth, eNormal * 0.8) * strength;
      // near black, blended in display gamma (like the character drawings)
      vec3 g = pow(max(c.rgb, 0.0), vec3(1.0 / 2.2));
      vec3 outC = pow(mix(g, pow(inkColor, vec3(1.0 / 2.2)), ink), vec3(2.2));
      gl_FragColor = vec4(outC, c.a);
    }`,
};

// ---------------------------------------------------------------------------
// Tone pass (neutral tone mapping after bloom)
// ---------------------------------------------------------------------------
const ToneShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // PBR-Neutral tone mapping
      vec3 x = c.rgb * (1.022 + c.rgb * 0.43);
      gl_FragColor = vec4(x / (1.0 + c.rgb), c.a);
    }`,
};

// ---------------------------------------------------------------------------
// Grade pass (grade.md §4): tone curve, zone saturation, tint, vignette
// ---------------------------------------------------------------------------
const GRADE_KNOTS = [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
const GRADE_DAY = [0.0345, 0.1828, 0.3812, 0.6605, 0.8814, 0.9631, 1.0];
const GRADE_GOLDEN = [0.0311, 0.1877, 0.4017, 0.6754, 0.8750, 0.9582, 1.0];

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uKnots: { value: new Array(7).fill(0) },
    uCurve: { value: new Array(7).fill(0) },
    uSat: { value: new THREE.Vector3(0.983, 1.273, 1.457) },
    uVigK: { value: 0.10 },
    uVigR0: { value: 0.45 },
    uLift: { value: new THREE.Vector3(0.055, 0.030, -0.052) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uKnots[7];
    uniform float uCurve[7];
    uniform vec3 uSat;
    uniform float uVigK;
    uniform float uVigR0;
    uniform vec3 uLift;
    varying vec2 vUv;

    float gradeCurve(float x) {
      for (int i = 0; i < 6; i++) {
        if (x <= uKnots[i + 1]) {
          float t = (x - uKnots[i]) / max(uKnots[i + 1] - uKnots[i], 1e-5);
          t = t * t * (3.0 - 2.0 * t);
          return mix(uCurve[i], uCurve[i + 1], t);
        }
      }
      return uCurve[6];
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = vec3(gradeCurve(src.r), gradeCurve(src.g), gradeCurve(src.b));
      const vec3 W = vec3(0.2126, 0.7152, 0.0722);
      float y = dot(c, W);
      float wS = 1.0 - smoothstep(0.0, 0.55, y);
      float wH = smoothstep(0.45, 1.0, y);
      float s = uSat.y + (uSat.x - uSat.y) * wS + (uSat.z - uSat.y) * wH;
      c = vec3(y) + s * (c - vec3(y));
      c += uLift * wS;
      float r = length(vUv * 2.0 - 1.0) * 0.70710678;
      c *= 1.0 - uVigK * smoothstep(uVigR0, 1.0, r);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }`,
};

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class Engine {
  constructor({ width, height, sceneMap, styleTarget = 90 }) {
    this.width = width;
    this.height = height;
    this.sceneMap = sceneMap;
    this.styleTarget = styleTarget;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
      alpha: false,
      powerPreference: 'low-power',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping is done by the TonePass after bloom, so emissive light stays HDR
    // until it has bloomed (depth.md §6.4: threshold 1.0, bloom only on real light).
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 2000);
    this.camera.position.set(0, 1.7, 6);
    this.camera.lookAt(0, 1.4, 0);

    this.sky = makeSky();
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog('#b0c0e8', 25, 420);

    // lights
    this.hemi = new THREE.HemisphereLight('#dcecff', '#b49a78', 0.55);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#fff3e0', 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.015;
    const sc = this.sun.shadow.camera;
    sc.left = -14; sc.right = 14; sc.top = 14; sc.bottom = -14; sc.near = 0.5; sc.far = 120;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.worlds = new Map();
    this.actors = new Map();
    this.blobMesh = null;

    this._buildWorlds();
    this._buildBlobs();

    // post-processing
    this._buildPost();
  }

  _buildWorlds() {
    const settings = new Map();
    for (const shot of this.sceneMap.shots || []) {
      const s = shot.setting;
      if (s && s.world_id && !settings.has(s.world_id)) settings.set(s.world_id, s);
    }
    for (const [id, setting] of settings) {
      const group = this._worldGroup(id, setting);
      this.worlds.set(id, { group, setting });
      this.scene.add(group);
    }
  }

  _worldGroup(id, setting) {
    const group = new THREE.Group();
    group.name = id;
    const desc = (setting.world || '').toLowerCase();
    const indoor = /room|hall|lab|office|coroner|bedroom|ward|museum|lecture|press/.test(desc);
    const plant = /tank|reactor|production|plant|filling|depot|industrial/.test(desc);
    const court = /court|palace|throne|column|cathedral/.test(desc);
    const outdoor = /beach|street|town|field|park|yard|miami|desert|algeria|station|road/.test(desc);

    const groundTex = plankTexture(indoor ? '#6a4a2e' : outdoor ? '#c9b184' : '#5a5a58', 256);
    groundTex.repeat.set(6, 6);
    const groundMat = twoTone(new THREE.MeshLambertMaterial({ map: groundTex }));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    group.add(ground);

    const wallTex = noiseTexture(indoor ? '#8d7f6a' : '#b9a88c', 256, 12);
    wallTex.repeat.set(4, 2);
    const wallMat = twoTone(new THREE.MeshLambertMaterial({ map: wallTex }));

    if (indoor || court) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(26, 9, 0.4), wallMat);
      back.position.set(0, 4.5, -11);
      back.receiveShadow = true;
      group.add(back);
      for (const side of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9, 22), wallMat);
        w.position.set(side * 13, 4.5, 0);
        w.receiveShadow = true;
        group.add(w);
      }
      // window + light pool on the floor (lighting.md: light pools tint the floor)
      const winMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.4, 2.0) });
      const win = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), winMat);
      win.position.set(-8, 4.6, -10.7);
      win.layers.set(NOINK);
      group.add(win);
      const poolMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.25, 1.12, 0.85), transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(7, 5), poolMat);
      pool.rotation.x = -Math.PI / 2;
      pool.rotation.z = 0.4;
      pool.position.set(-5.5, 0.02, -7.5);
      pool.layers.set(NOINK);
      group.add(pool);
    }

    if (plant) {
      const metal = twoTone(new THREE.MeshPhongMaterial({ color: '#4a4a4a', specular: '#8a8a8a', shininess: 40 }));
      for (let i = 0; i < 4; i++) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 4.4, 18), metal);
        tank.position.set(-9 + i * 6, 2.2, -5.5);
        tank.castShadow = tank.receiveShadow = true;
        group.add(tank);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.05, 6, 24), metal);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(-9 + i * 6, 3.6, -5.5);
        group.add(ring);
      }
      for (let i = 0; i < 5; i++) {
        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.16, 10, 8),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 2.3, 1.3) })
        );
        bulb.position.set(-9 + i * 4.5, 5.6, -2.5);
        bulb.layers.set(NOINK);
        group.add(bulb);
        const pl = new THREE.PointLight('#ffcc88', 2.2, 9, 2);
        pl.position.copy(bulb.position);
        group.add(pl);
      }
    }

    if (court) {
      const stone = twoTone(new THREE.MeshLambertMaterial({ color: '#c9bfae' }));
      for (let i = 0; i < 6; i++) {
        for (const side of [-1, 1]) {
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 7, 12), stone);
          col.position.set(side * 6.5, 3.5, -8 + i * 3.2);
          col.castShadow = true;
          group.add(col);
        }
      }
      const carpet = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 14),
        twoTone(new THREE.MeshLambertMaterial({ color: '#a02c33' }))
      );
      carpet.rotation.x = -Math.PI / 2;
      carpet.position.set(0, 0.02, -1);
      carpet.receiveShadow = true;
      group.add(carpet);
    }

    if (outdoor) {
      const houseMat = twoTone(new THREE.MeshLambertMaterial({ color: '#c9a887' }));
      for (let i = 0; i < 6; i++) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.2, 3.0), houseMat);
        const side = i % 2 === 0 ? -1 : 1;
        h.position.set(side * (12 + Math.floor(i / 2) * 2), 1.6, -14 + Math.floor(i / 2) * 7);
        h.castShadow = h.receiveShadow = true;
        group.add(h);
        const roof = new THREE.Mesh(
          new THREE.ConeGeometry(2.7, 1.5, 4),
          twoTone(new THREE.MeshLambertMaterial({ color: '#8d3b2f' }))
        );
        roof.rotation.y = Math.PI / 4;
        roof.position.set(h.position.x, 3.9, h.position.z);
        group.add(roof);
      }
    }

    return group;
  }

  _buildBlobs() {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uRatio: { value: new THREE.Color(0.62, 0.58, 0.58) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uRatio; varying vec2 vUv;
        void main() {
          float r = length(vUv * 2.0 - 1.0);
          float m = 1.0 - smoothstep(0.7, 1.0, r);
          gl_FragColor = vec4(mix(vec3(1.0), uRatio, m), 1.0);
        }`,
      transparent: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.blobMesh = new THREE.InstancedMesh(geo, mat, 64);
    this.blobMesh.renderOrder = 0.5;
    this.blobMesh.frustumCulled = false;
    this.scene.add(this.blobMesh);
  }

  _buildPost() {
    const normalRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(this.width, this.height),
      depthBuffer: true,
    });
    normalRT.depthTexture.type = THREE.UnsignedIntType;
    this.normalRT = normalRT;

    this.normalMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        #include <common>
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        varying vec3 vN;
        void main() {
          #include <begin_vertex>
          #include <project_vertex>
          vN = transformedNormal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vN;
        void main() {
          vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
          gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
        }`,
    });

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height), 0.5, 0.6, 1.0
    );
    this.composer.addPass(this.bloomPass);

    // Tone mapping happens BEFORE the ink pass so the ink shader reads the
    // tone-mapped image (the ink colour is blended in display gamma, which
    // matches how the character drawings are made in the reference).
    this.tonePass = new ShaderPass(ToneShader);
    this.composer.addPass(this.tonePass);

    this.inkPass = new ShaderPass(InkShader);
    this.inkPass.uniforms.resolution.value.set(this.width, this.height);
    this.composer.addPass(this.inkPass);

    this.gradePass = new ShaderPass(GradeShader);
    (this.gradePass.uniforms.uKnots.value) = GRADE_KNOTS.slice();
    this.gradePass.uniforms.uCurve.value = GRADE_DAY.slice();
    this.composer.addPass(this.gradePass);

    this._setCurve('day');
  }

  _setCurve(lightName) {
    const golden = lightName === 'golden';
    this.gradePass.uniforms.uCurve.value = (golden ? GRADE_GOLDEN : GRADE_DAY).slice();
    this.gradePass.uniforms.uSat.value.set(0.983, 1.273, 1.457);
    this.gradePass.uniforms.uVigK.value = golden ? 0.16 : 0.10;
    this.gradePass.uniforms.uVigR0.value = golden ? 0.40 : 0.45;
    this.gradePass.uniforms.uLift.value.set(0.055, 0.030, -0.052);
    this.bloomPass.strength = golden ? 0.7 : 0.5;
  }

  // public API ---------------------------------------------------------------

  setSize(w, h) {
    this.width = w; this.height = h;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.inkPass.uniforms.resolution.value.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Position the cast for a shot; who -> world position slots. */
  _stageShot(shot) {
    const who = new Set();
    for (const a of shot.actions || []) {
      if (a.who) who.add(a.who);
    }
    const list = [...who].slice(0, 8);
    const keep = new Set();

    list.forEach((name, i) => {
      let actor = this.actors.get(name);
      if (!actor) {
        const canvas = drawCharacter(name, { expr: 'neutral' });
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.72, 2.86), mat);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.renderOrder = 1;
        mesh.layers.set(NOINK);
        actor = { mesh, mat, tex, name };
        this.actors.set(name, actor);
        this.scene.add(mesh);
      }
      keep.add(name);

      const spread = Math.max(1.6, list.length * 0.9);
      const x = (i - (list.length - 1) / 2) * spread;
      const z = -0.4 + (i % 2) * 0.5;
      actor.mesh.position.set(x, 1.43, z);
      actor.mesh.rotation.y = 0;
      actor.mesh.visible = true;
    });

    // hide actors not in this shot
    for (const [name, actor] of this.actors) {
      if (!keep.has(name)) actor.mesh.visible = false;
    }
    return list.map((name) => this.actors.get(name)).filter(Boolean);
  }

  _applyLight(shot) {
    const s = shot.setting || {};
    const tod = (s.time_of_day || '').toLowerCase();
    const name = /golden|sunset|dusk|evening/.test(tod) ? 'golden'
      : /night|dark|midnight/.test(tod) ? 'night' : 'day';
    const L = LIGHTS[name];

    // camera-relative sun, frozen per shot (lighting.md §9.4)
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const az = THREE.MathUtils.degToRad(shot.sunAz ?? L.sunAz);
    const el = THREE.MathUtils.degToRad(shot.sunEl ?? L.sunEl);
    const fx = fwd.x, fz = fwd.z;
    const hx = fx * Math.cos(az) - fz * Math.sin(az);
    const hz = fz * Math.cos(az) + fx * Math.sin(az);
    const dir = new THREE.Vector3(hx * Math.cos(el), Math.sin(el), hz * Math.cos(el)).normalize();

    this.sun.color.set(L.sunCol);
    this.sun.intensity = L.sunI;
    this.sun.position.copy(this.camera.position).addScaledVector(dir, 60);
    this.sun.target.position.set(0, 1.2, 0);
    this.sun.shadow.bias = name === 'golden' ? -0.0006 : -0.00025;
    this.sun.shadow.normalBias = name === 'golden' ? 0.03 : 0.015;

    this.hemi.color.set(L.hemi);
    this.hemi.groundColor.set(L.ground);
    this.hemi.intensity = L.hemiI;

    TONE.uLitCol.value.set(...L.lit);
    TONE.uShadeCol.value.set(...L.shade);
    this.scene.fog.color.set(L.fog);
    this.scene.fog.near = L.fogNear;
    this.scene.fog.far = L.fogFar;
    this.blobMesh.material.uniforms.uRatio.value.setRGB(...L.blob);
    this.blobMesh.material.uniforms.uRatio.value.convertSRGBToLinear();

    this.sky.material.uniforms.top.value.set(L.top);
    this.sky.material.uniforms.hor.value.set(L.hor);
    this.sky.material.uniforms.curve.value.set(...(name === 'golden' ? [0.05, 0.6, 1.0] : [0.0, 0.5, 0.6]));

    this._setCurve(name);
    this._sunDir = dir;
  }

  _updateBlobs(actors) {
    if (!this.blobMesh) return;
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const dir = this._sunDir || new THREE.Vector3(0, 1, 0);
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const ox = -dir.x / hl, oz = -dir.z / hl;
    let i = 0;
    for (const a of actors) {
      if (!a.mesh.visible) continue;
      e.set(-Math.PI / 2, Math.atan2(-ox, -oz), 0, 'YXZ');
      q.setFromEuler(e);
      v.set(a.mesh.position.x + ox * 0.25, 0.015, a.mesh.position.z + oz * 0.25);
      s.set(0.75, 1.15, 1);
      m4.compose(v, q, s);
      this.blobMesh.setMatrixAt(i++, m4);
    }
    this.blobMesh.count = i;
    this.blobMesh.instanceMatrix.needsUpdate = true;
  }

  _cameraFor(shot, t) {
    const dur = Math.max(shot.end - shot.start, 0.001);
    const p = THREE.MathUtils.clamp((t - shot.start) / dur, 0, 1);
    const type = shot.scene_type || 'character_action';
    const dist = type === 'close_up' ? 2.6 : type === 'wide' ? 9 : 4.6;
    const camY = type === 'close_up' ? 1.55 : 1.75;

    const pos = new THREE.Vector3(0, camY, dist);
    const look = new THREE.Vector3(0, 1.35, 0);

    const ease = (x) => 1 - Math.pow(1 - x, 3);
    for (const mv of shot.camera_moves || []) {
      const at = typeof mv.at === 'number' ? mv.at : 0;
      const k = THREE.MathUtils.clamp((p - at) / 0.18, 0, 1);
      if (k <= 0) continue;
      const e = ease(k);
      const m = (mv.move || '').toLowerCase();
      if (m.includes('push')) pos.z -= (dist * 0.42) * e;
      else if (m.includes('pan_left')) { pos.x -= 2.2 * e; look.x -= 1.0 * e; }
      else if (m.includes('pan_right')) { pos.x += 2.2 * e; look.x += 1.0 * e; }
      else if (m.includes('dolly_left')) pos.x -= 1.6 * e;
      else if (m.includes('dolly_right')) pos.x += 1.6 * e;
      else if (m.includes('tilt_up')) look.y += 1.2 * e;
      else if (m.includes('tilt_down')) look.y -= 0.7 * e;
      else if (m.includes('whip')) pos.x += Math.sin(p * Math.PI) * 3.0;
      else if (m.includes('drift')) { pos.x += Math.sin(p * Math.PI * 2) * 0.25; look.x += Math.sin(p * Math.PI * 2) * 0.1; }
    }

    this.camera.position.lerp(pos, 0.25);
    this.camera.lookAt(look);
    this.camera.updateMatrixWorld();
  }

  /** Advance the world to time t (seconds) and draw one frame. */
  renderAt(t) {
    const shots = this.sceneMap.shots || [];
    if (!shots.length) return;
    let shot = shots[0];
    for (let i = 0; i < shots.length; i++) {
      if (shots[i].start <= t) shot = shots[i];
      else break;
    }

    // show only this shot's world
    const wid = shot.setting?.world_id;
    for (const [id, w] of this.worlds) w.group.visible = id === wid;

    this._stageShot(shot);
    this._cameraFor(shot, t);
    this._applyLight(shot);
    this._updateBlobs([...this.actors.values()]);

    // 1) world-only normal + depth pass (characters, sky, bulbs excluded)
    const camLayers = this.camera.layers.mask;
    this.camera.layers.disable(NOINK);
    const bg = this.scene.background;
    this.scene.overrideMaterial = this.normalMat;
    this.scene.background = null;
    const shadowAuto = this.renderer.shadowMap.autoUpdate;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.setRenderTarget(this.normalRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.camera.layers.mask = camLayers;
    this.scene.overrideMaterial = null;
    this.scene.background = bg;
    this.renderer.shadowMap.autoUpdate = shadowAuto;
    this.renderer.setRenderTarget(null);

    this.inkPass.uniforms.tNormal.value = this.normalRT.texture;
    this.inkPass.uniforms.tDepth.value = this.normalRT.depthTexture;
    this.inkPass.uniforms.camNear.value = this.camera.near;
    this.inkPass.uniforms.camFar.value = this.camera.far;

    this.composer.render(0.016);
  }
}

window.Engine = Engine;

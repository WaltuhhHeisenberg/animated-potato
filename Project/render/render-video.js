/**
 * Headless render driver.
 *
 *   1. serves the project + local three.js on localhost
 *   2. opens render/frames.html in headless Chromium (SwiftShader WebGL)
 *   3. asks the page for one PNG per frame (deterministic, fixed timestep)
 *   4. encodes the PNG sequence to MP4 with FFmpeg
 *   5. runs scripts/style_match.py and FAILS the run below 90%
 *
 * Rendering never happens locally on the author's machine — GitHub Actions runs
 * this on a clean Ubuntu runner.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { createServer } = require('./static-server');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ROOT = path.resolve(__dirname, '..');
const opt = {
  sceneMap: path.resolve(ROOT, arg('scene-map', '05-scene-map (1).json')),
  width: parseInt(arg('width', '1920'), 10),
  height: parseInt(arg('height', '1080'), 10),
  fps: parseInt(arg('fps', '30'), 10),
  output: path.resolve(ROOT, arg('output', 'output.mp4')),
  framesDir: path.resolve(ROOT, arg('frames-dir', 'frames')),
  styleDir: path.resolve(ROOT, arg('style', 'style')),
  styleTarget: parseFloat(arg('style-target', '90')),
  maxFrames: parseInt(arg('max-frames', '0'), 10),   // 0 = all
};

function log(...a) { console.log(...a); }

async function main() {
  const t0 = Date.now();
  log('three.js story render');
  log('  scene map :', opt.sceneMap);
  log('  size      :', `${opt.width}x${opt.height} @ ${opt.fps}fps`);

  if (!fs.existsSync(opt.sceneMap)) throw new Error('scene map not found: ' + opt.sceneMap);
  const sceneMap = JSON.parse(fs.readFileSync(opt.sceneMap, 'utf8'));
  const shots = sceneMap.shots || [];
  if (!shots.length) throw new Error('scene map has no shots');

  const duration = shots.reduce((m, s) => Math.max(m, s.end), 0);
  const totalFrames = Math.min(
    Math.ceil(duration * opt.fps),
    opt.maxFrames > 0 ? opt.maxFrames : Infinity
  );
  log('  duration  :', duration.toFixed(2) + 's ->', totalFrames, 'frames');

  fs.rmSync(opt.framesDir, { recursive: true, force: true });
  fs.mkdirSync(opt.framesDir, { recursive: true });

  const threeDir = path.join(ROOT, 'node_modules', 'three');
  const server = createServer({ root: ROOT, threeDir, sceneMap: opt.sceneMap });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  log('  serving   :', `http://127.0.0.1:${port}`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      `--window-size=${opt.width},${opt.height}`,
    ],
  });

  const page = await browser.newPage({ viewport: { width: opt.width, height: opt.height } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/?w=${opt.width}&h=${opt.height}`, {
      waitUntil: 'load',
    });
    await page.waitForFunction('window.__ready === true || window.__error', null, { timeout: 60000 });
    const err = await page.evaluate(() => window.__error);
    if (err) throw new Error('engine failed: ' + err);
    log('  engine    : ready');

    for (let f = 0; f < totalFrames; f++) {
      const t = f / opt.fps;
      const dataUrl = await page.evaluate((tt) => window.renderFrame(tt), t);
      const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      fs.writeFileSync(path.join(opt.framesDir, `frame_${String(f).padStart(6, '0')}.png`), png);

      if (f % 30 === 0 || f === totalFrames - 1) {
        const pct = ((f + 1) / totalFrames * 100).toFixed(1);
        process.stdout.write(`\r  frames    : ${f + 1}/${totalFrames} (${pct}%)   `);
      }
    }
    log('');
  } finally {
    await browser.close();
    server.close();
  }

  // ---- encode ---------------------------------------------------------------
  log('  encoding  :', path.basename(opt.output));
  fs.mkdirSync(path.dirname(opt.output), { recursive: true });
  const enc = spawnSync(ffmpegPath, [
    '-y',
    '-framerate', String(opt.fps),
    '-i', path.join(opt.framesDir, 'frame_%06d.png'),
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    opt.output,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (enc.status !== 0) throw new Error('ffmpeg failed:\n' + enc.stderr);
  const mb = (fs.statSync(opt.output).size / 1048576).toFixed(1);
  log('  output    :', path.basename(opt.output), `(${mb} MB)`);

  // ---- style gate -----------------------------------------------------------
  log('\nstyle gate (target ' + opt.styleTarget + '%)');
  const py = spawnSync('python3', [
    path.join(ROOT, 'scripts', 'style_match.py'),
    'check',
    opt.framesDir,
    '--montage', path.join(ROOT, 'montage.jpg'),
    '--json', path.join(ROOT, 'style-report.json'),
  ], { stdio: 'inherit' });

  if (py.status === 1) {
    console.error(`\nSTYLE GATE FAILED — render is below ${opt.styleTarget}% or a dimension is under 80%.`);
    console.error('See style-report.json / montage.jpg for what to fix.');
    process.exit(2);
  }
  if (py.status !== 0 && py.status !== null) {
    console.error(`\nstyle_match.py exited with ${py.status}`);
    process.exit(3);
  }

  log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e) => {
  console.error('\nrender failed:', e.message);
  process.exit(1);
});

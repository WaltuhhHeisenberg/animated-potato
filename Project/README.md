# Three.js Story Video Renderer

Renders a story video from a **scene map** + **transcript**, in the **painted-ink** style of the reference channel. Style accuracy is measured against 20 reference contact sheets and gated at **90% overall** (every dimension ≥ 80%) — the render fails the pipeline if it does not pass.

## Layout

```
.
├── index.html                 # web UI: scene map / transcript / style / render
├── css/styles.css
├── js/                        # UI modules
│   ├── main.js
│   ├── scene-map.js
│   ├── transcript.js
│   ├── style-analyzer.js
│   └── renderer.js
├── render/
│   ├── scene-engine.js        # three.js engine: cards + worlds + ink + grade
│   ├── frames.html            # page the headless renderer loads
│   ├── static-server.js       # serves the project + local three.js
│   └── render-video.js        # Playwright driver: capture → encode → style gate
├── scripts/
│   └── style_match.py         # Gate 2: measures frames against the sheets
├── style/                     # reference style bible + 20 contact sheets
│   ├── STYLE_BIBLE.md  grade.md  lighting.md  outlines.md
│   ├── depth.md  motion.md  textures.md  characters.md  INDEX.md  CONTEXT.md
│   ├── ref_stats.json
│   └── sheets/short01..short20_sheet.jpg
├── 05-scene-map (1).json      # scene map (56 clauses, 204.9 s)
├── transcript.csv             # word-level transcript
├── .github/workflows/render.yml
└── README.md
```

## How the style is applied

| Source | What it says | Where it lives |
|---|---|---|
| `style/STYLE_BIBLE.md` | whole style on one page | `render/scene-engine.js` |
| `style/grade.md` | tone curve, saturation zones, tints, vignette | `GradeShader` in `scene-engine.js` |
| `style/lighting.md` | key/fill/shade ratios, violet shade, light pools | `LIGHTS` presets + `twoTone()` |
| `style/outlines.md` | ink line widths, colour, depth+crease rules | `InkShader` + `normalRT` pass |
| `style/depth.md` | DOF, fog, sky curve, bloom | `makeSky()`, fog, bloom pass |
| `style/motion.md` | camera grammar, character animation | `_cameraFor()`, `_stageShot()` |
| `style/textures.md` | painted textures, sky stops, cloud tones | `plankTexture()`, `noiseTexture()` |
| `style/characters.md` | head shape, 3.5 HH bodies, face library | `drawCharacter()` |
| `style/sheets/*.jpg` | 20 contact sheets (the style gate) | `scripts/style_match.py` |

## Run the render

Rendering **never happens locally** — it runs on GitHub Actions.

```bash
# from the repo root
npm install
npm run render
```

Or trigger the workflow:

```
Actions → Render Three.js Video → Run workflow
```

Inputs: scene map path, transcript, style dir, resolution, FPS, output filename.

## Style gate

```
python scripts/style_match.py check <frames-dir> --montage montage.jpg --json style-report.json
```

Passes at **90% overall** and **≥ 80% on every dimension** (characters, movement, lighting, textures, colors, camera, motion, depth, grade). Fails the run otherwise.
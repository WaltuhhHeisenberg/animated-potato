# Painted-ink style: index (what each file is for, who reads it, which code implements it)

The studio's look is **painted ink**: colourful high-contrast 3D toon worlds, thin black ink lines on the geometry, painted flat colour with sparse tufts, warm key light with blue-violet shadows, deep blurred backgrounds, bloom only on real lights, big-headed lively characters with thin ink limbs, and a camera that is almost always moving in eased glides. It replaces the old GTA San Andreas look completely.

Private study material: the reports and sheets below were measured from reference shorts. Derive rules and numbers from them; never trace or copy a specific character, prop or shot, and never upload or publish the sheets (`CONTEXT.md` says the same).
The reports were written for another stack (Remotion + react-three-fiber). Their numbers are the targets; this plugin implements them in `toon-studio/src` as listed here.

| File | What it holds | Read it when | Implemented in |
|---|---|---|---|
| `STYLE_BIBLE.md` | the whole style on one page: format, script formula, picture, camera, effects, colour stats | before any visual work | everything |
| `grade.md` | tone curves, saturation per zone, tints, vignette (day / golden), colour targets and hex palettes | worlds, lighting, grade, QA | `look.mjs` (GRADES), palettes in `world.mjs` |
| `lighting.md` | key / fill / shade ratios, violet shade, light on characters, shadows, light pools | worlds, lighting, characters | `world.mjs` (hemi, sun, shadow map), `engine.mjs` (toon ramps) |
| `outlines.md` | ink line widths, colour, depth and crease rules, character outline | worlds, props, characters | `post.mjs` (applyInk), `engine.mjs` (INK_PLUM hull) |
| `depth.md` | depth of field per shot size, fog, sky curve, bloom, composition | worlds, camera plan | `post.mjs` (applyDof, applyBloom), `scene.mjs` (DOF_SIGMA), `world.mjs` (sky stops, fog) |
| `textures.md` | painted textures, sky stops, cloud tones, ground paint | worlds, props, textures | `world.mjs` (paintTexture, terrain, clouds) |
| `characters.md` | head shape, 3.5 head-heights, limbs, hands, eyes, brows, mouth, colours | characters | `characters.mjs` (createCharacter) |
| `motion.md` | camera grammar (hold / drift / move shares, eases, push-ins, whips), character animation, blink timing | movements, camera plan, scene mapping | `scene.mjs` (drift, reframe, push, BLEND), `characters.mjs` (bob, lean, blink, custom actions) |
| `CONTEXT.md` | how the reference study was set up (stack, frame extraction, caption masking) | only to understand the reports | none |
| `sheets/shortNN_sheet.jpg` (20) | contact sheets of the 20 reference videos, 9 x 6 tiles | the style gate, every look decision, the reviewer's by-eye comparison | `scripts/style_match.py`, `ref_stats.json` |
| `ref_stats.json` | per-metric ranges measured from the sheets plus the 30 fps motion bands | the style gate | `scripts/style_match.py` |

## The style gate (Gate 2, rule G2-20)
`python scripts/style_match.py check <video-or-frames> --montage montage.jpg` scores the render on 9 dimensions (characters, movement, lighting, textures, colors, camera, motion, depth, grade) against the sheets and the motion bands. It passes only at **90 % overall and at least 80 % in every dimension**. It runs inside `toon_qa.py gate2` and fails the gate otherwise; the reviewer also compares the montage with the sheets by eye. Rebuild the ranges with `python scripts/style_match.py build-ref` after changing the sheets.

## Where the style is applied, stage by stage
- Scene map: `settings`, dense `actions`, `camera_moves`, camera-carried `carry` links (`skills/scene-mapping/reference/camera-links.md`).
- Assets: worlds (grade, sky stops, fog, light), props (painted accents), characters (egg head, thin limbs), movements (keyframed), lighting and textures, camera plan (`skills/make-3d-assets/SKILL.md`).
- Render: ink lines, depth of field, bloom and grade run automatically (`look: "painted_ink"` in the project).
- QA: Gate 2 style match.

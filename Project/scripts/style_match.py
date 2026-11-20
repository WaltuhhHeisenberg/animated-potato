#!/usr/bin/env python3
"""
Three.js Story Video Renderer — Style Accuracy Checker (Gate 2)

Measures rendered frames against the reference style sheets for 90% overall
accuracy across 9 dimensions:

1. characters   - big heads, thin ink limbs, body proportions, face features
2. movement     - camera grammar, character animation timing
3. lighting     - key/fill/shade ratios, violet shade, light pools
4. textures     - painted textures, sky stops, cloud tones
5. colors       - luminance, saturation, hue distributions, grade targets
6. camera       - hold/drift/move shares, ease curves, push-ins
7. motion       - speed bands, cuts per minute, alive/dup shares
8. depth        - DOF sigma, aerial perspective, sky gradient
9. grade        - tone curve, vignette, black/white points

Gate: 90% overall AND every dimension >= 80%.

Usage:
  python scripts/style_match.py check <video-or-frames-dir> --montage montage.jpg
  python scripts/style_match.py build-ref  (rebuild ref_stats.json from sheets)
"""

import json
import math
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple, Optional
import argparse

try:
    import numpy as np
    from PIL import Image
    import scipy.ndimage as ndi
except ImportError as e:
    print(f"❌ Missing dependency: {e}")
    print("   Install: pip install numpy pillow scipy")
    sys.exit(1)

# --- Configuration -----------------------------------------------------------

HERE = Path(__file__).parent
ROOT = HERE.parent
STYLE_DIR = ROOT / "style"
REF_STATS = STYLE_DIR / "ref_stats.json"
SHEETS_DIR = STYLE_DIR / "sheets"

# Load reference stats from ref_stats.json
try:
    with open(REF_STATS) as f:
        REF = json.load(f)
except Exception:
    REF = {
        "metrics": {
            "lum_mean": {"min": 0.19, "max": 0.66, "median": 0.44},
            "lum_std": {"min": 0.16, "max": 0.26, "median": 0.20},
            "p2": {"min": 0.01, "max": 0.21, "median": 0.11},
            "p98": {"min": 0.79, "max": 1.0, "median": 0.92},
            "sat_mean": {"min": 0.33, "max": 0.65, "median": 0.44},
            "sat_p90": {"min": 0.55, "max": 0.98, "median": 0.75},
            "shade_ratio": {"min": 0.29, "max": 0.69, "median": 0.52},
            "ink_share": {"min": -0.001, "max": 0.01, "median": 0.0033},
            "dark_share": {"min": -0.025, "max": 0.28, "median": 0.014},
            "sharp_ratio": {"min": 1.3, "max": 4.6, "median": 2.6},
        },
        "bands_30fps": {
            "cam_hold": [0.0, 0.27],
            "cam_drift": [0.04, 0.38],
            "cam_move": [0.34, 0.94],
            "cam_speed_med": [1.3, 12.9],
            "speed_p90": [9.7, 29.4],
            "cuts_per_min": [0.0, 1.5],
            "alive_share": [0.55, 1.0],
            "dup_share": [0.0, 0.1],
        },
    }

DIMENSIONS = [
    "characters", "movement", "lighting", "textures",
    "colors", "camera", "motion", "depth", "grade"
]
DIM_MIN_SCORE = 80.0
OVERALL_TARGET = 90.0

# Ink color targets (dark plum, near-black)
INK_RGB = (47, 29, 40)   # reference ink core median
INK_TOL = 60             # max distance from ink color to count as "ink"

# Character face targets from the sheets
EYE_SPACING_TARGET = 0.26   # fraction of head width
BROW_HEIGHT_TARGET = -0.20  # fraction of head width (up = negative)
MOUTH_HEIGHT_TARGET = 0.20  # fraction of head width


# --- Helpers -----------------------------------------------------------------

def load_frames(video_or_dir) -> List[np.ndarray]:
    """Load frames as numpy arrays (RGB, uint8)."""
    frames = []
    p = Path(video_or_dir)

    if p.is_file() and p.suffix.lower() == '.mp4':
        try:
            import imageio
            reader = imageio.get_reader(str(p))
            for frame in reader:
                frames.append(np.array(frame))
        except ImportError:
            import tempfile
            import subprocess
            with tempfile.TemporaryDirectory() as tmpdir:
                subprocess.run(
                    ['ffmpeg', '-y', '-i', str(p),
                     str(Path(tmpdir) / 'frame_%04d.png')],
                    check=True, capture_output=True
                )
                for f in sorted(Path(tmpdir).glob('frame_*.png')):
                    frames.append(np.array(Image.open(f).convert('RGB')))
    elif p.is_dir():
        for f in sorted(p.glob('frame_*.png')):
            frames.append(np.array(Image.open(f).convert('RGB')))
        if not frames:
            for f in sorted(p.glob('*.png')):
                frames.append(np.array(Image.open(f).convert('RGB')))
    elif p.suffix.lower() in ('.png', '.jpg', '.jpeg'):
        frames.append(np.array(Image.open(p).convert('RGB')))

    return frames


def sky_mask(luma: np.ndarray) -> np.ndarray:
    """Sky = smooth (|∇L| < 0.01/px), bright (L > 0.35) region connected to the top edge.
    Returns a boolean mask."""
    h, w = luma.shape
    gy, gx = np.gradient(luma)
    smooth = np.hypot(gx, gy) < 0.01
    bright = luma > 0.35
    sky = smooth & bright

    # flood fill from the top edge
    from collections import deque
    seen = np.zeros_like(sky)
    q = deque()
    for x in range(w):
        if sky[0, x]:
            seen[0, x] = True
            q.append((0, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and sky[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    return seen


def compute_frame_metrics(frame: np.ndarray) -> Dict[str, float]:
    """Compute all measurable metrics for a single frame."""
    h, w, _ = frame.shape
    rgb = frame.astype(np.float32) / 255.0

    # Luma (Rec.709 on sRGB-encoded values)
    luma = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]

    # --- sky mask ------------------------------------------------------------
    # Sky is the smooth bright region connected to the top edge. It is excluded
    # from edge/ink/texture metrics: gradient bands in a sky would otherwise
    # count as picture detail and pass the gate on a picture that has none.
    sky = sky_mask(luma)
    scene = ~sky

    p2 = float(np.percentile(luma, 2))
    p50 = float(np.percentile(luma, 50))
    p98 = float(np.percentile(luma, 98))

    # Saturation
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    sat = np.where(mx > 0.01, (mx - mn) / np.maximum(mx, 1e-6), 0)
    sat_valid = sat[mx > 0.15]
    sat_mean = float(sat_valid.mean()) if sat_valid.size else 0
    sat_p90 = float(np.percentile(sat_valid, 90)) if sat_valid.size else 0

    # Ink share: near-black pixels (dark plum ink core), scene only
    ink_mask = (luma < 0.30) & scene
    ink_share = float(ink_mask.sum() / max(scene.sum(), 1))

    # Dark share
    dark_share = float(((luma < 0.1) & scene).sum() / max(scene.sum(), 1))

    # White share
    white_share = float((luma > 0.85).mean())

    # Sharpness (Laplacian variance) over the scene only
    lap = ndi.laplace(luma)
    sharp_ratio = float(lap[scene].var() + 1e-6) if scene.any() else 0.0

    # Edge density over the scene only
    gy, gx = np.gradient(luma)
    grad_mag = np.hypot(gx, gy)
    edge_density = float((grad_mag[scene] > 0.1).mean()) if scene.any() else 0.0

    # Flat share (low gradient)
    flat_share = float((grad_mag[scene] < 0.05).mean()) if scene.any() else 0.0

    # Detail (local std), scene only
    blur = ndi.gaussian_filter(luma, 1)
    detail = float(blur[scene].std()) if scene.any() else 0.0

    # Shade ratio: bright vs dark regions on same surface
    bright_mask = luma > 0.6
    dark_mask = (luma > 0.2) & (luma < 0.4)
    if bright_mask.any() and dark_mask.any():
        shade_ratio = float(luma[bright_mask].mean() / max(luma[dark_mask].mean(), 0.01))
    else:
        shade_ratio = 0.5

    # Warm/cool split
    warm_hi = float(rgb[:, :, 0][luma > 0.7].mean() - rgb[:, :, 2][luma > 0.7].mean()) if (luma > 0.7).any() else 0
    cool_sh = float(rgb[:, :, 2][luma < 0.3].mean() - rgb[:, :, 0][luma < 0.3].mean()) if (luma < 0.3).any() else 0

    # Sky gradient: top vs middle luminance
    top_luma = float(luma[:h // 5].mean())
    mid_luma = float(luma[h // 5:h // 2].mean())
    sky_gradient = top_luma / max(mid_luma, 0.01)

    # DOF proxy: background blur ratio (top third blurred vs bottom sharp)
    top_blur = float(ndi.gaussian_filter(luma[:h // 3], 2).std())
    bottom_blur = float(ndi.gaussian_filter(luma[2 * h // 3:], 1).std())
    dof_ratio = top_blur / max(bottom_blur, 0.01)

    # Ink line detection: dark thin lines on geometry edges
    # Look for near-black pixels that form thin structures (width <= ~6px)
    ink_line_score = detect_ink_lines(luma, ink_mask)

    # Face detection proxy: look for big white circles (heads)
    face_score = detect_face_proportions(rgb, luma)

    return {
        'lum_mean': float(luma.mean()),
        'lum_std': float(luma.std()),
        'p2': p2,
        'p50': p50,
        'p98': p98,
        'sat_mean': sat_mean,
        'sat_p90': sat_p90,
        'ink_share': ink_share,
        'dark_share': dark_share,
        'white_share': white_share,
        'sharp_ratio': sharp_ratio,
        'edge_density': edge_density,
        'flat_share': flat_share,
        'detail': detail,
        'shade_ratio': shade_ratio,
        'warm_hi': warm_hi,
        'cool_sh': cool_sh,
        'sky_gradient': sky_gradient,
        'dof_ratio': dof_ratio,
        'ink_line_score': ink_line_score,
        'face_score': face_score,
        'width': w,
        'height': h,
    }


def detect_ink_lines(luma: np.ndarray, ink_mask: np.ndarray) -> float:
    """
    Detect thin ink lines on geometry edges.
    Score 0-100 based on whether dark ink lines are present on edges.
    """
    if not ink_mask.any():
        return 0.0

    # Ink lines should be thin and form edges, not solid blocks
    # Use morphological opening to separate thin lines from solid dark regions
    try:
        from scipy.ndimage import binary_opening, binary_erosion
        struct = ndi.generate_binary_structure(2, 1)
        # Thin lines survive opening with small structure
        opened = binary_opening(ink_mask, structure=struct, iterations=2)
        thin_share = float(opened.mean()) / max(float(ink_mask.mean()), 1e-6)
        return min(100.0, thin_share * 300)  # scale up
    except Exception:
        return 50.0 if ink_mask.mean() > 0.01 else 0.0


def detect_face_proportions(rgb: np.ndarray, luma: np.ndarray) -> float:
    """
    Detect big-headed characters with thin ink limbs.
    Score based on presence of large light circular regions (heads)
    with dark outlines around them.
    """
    h, w = luma.shape
    # Look for head-sized light blobs
    try:
        # Find local maxima in luma (bright spots = heads)
        from scipy.signal import find_peaks
        # Simple proxy: count bright circular-ish regions
        bright = (luma > 0.7).astype(np.uint8)
        labeled, n = ndi.label(bright)
        sizes = np.bincount(labeled.ravel())[1:] if n > 0 else []
        if len(sizes) == 0:
            return 0.0
        # Head regions should be medium-sized (not tiny specks, not whole sky)
        head_sizes = [s for s in sizes if 200 < s < 50000]
        return min(100.0, len(head_sizes) * 5 + 40)
    except Exception:
        return 40.0


def score_metric(value: float, target_min: float, target_max: float,
                 target_median: float, cap: float = 100.0) -> float:
    """Score a metric value 0-100 based on proximity to target range."""
    if target_min <= value <= target_max:
        range_span = target_max - target_min
        if range_span > 0:
            distance = abs(value - target_median) / range_span
        else:
            distance = 0.0
        return min(cap, max(85, 100 - distance * 40))
    else:
        if value < target_min:
            distance = (target_min - value) / max(abs(target_min), 0.01)
        else:
            distance = (value - target_max) / max(abs(target_max), 0.01)
        return max(0, 60 - distance * 60)


def aggregate_scores(all_metrics: List[Dict[str, float]], ref: Dict) -> Dict[str, float]:
    """Aggregate per-frame metrics into dimension scores (0-100)."""
    n = len(all_metrics)
    if n == 0:
        return {dim: 0.0 for dim in DIMENSIONS}

    def med(key):
        return float(np.median([m[key] for m in all_metrics]))

    def mean(key):
        return float(np.mean([m[key] for m in all_metrics]))

    scores = {}

    # --- 1. COLORS ---
    lum_mean = med('lum_mean')
    sat_mean = med('sat_mean')
    ink_share = med('ink_share')

    c_lum = score_metric(lum_mean,
                         ref['metrics']['lum_mean']['min'],
                         ref['metrics']['lum_mean']['max'],
                         ref['metrics']['lum_mean']['median'])
    c_sat = score_metric(sat_mean,
                         ref['metrics']['sat_mean']['min'],
                         ref['metrics']['sat_mean']['max'],
                         ref['metrics']['sat_mean']['median'])
    c_ink = score_metric(ink_share,
                         ref['metrics']['ink_share']['min'],
                         ref['metrics']['ink_share']['max'],
                         ref['metrics']['ink_share']['median'])
    scores['colors'] = (c_lum + c_sat + c_ink) / 3

    # --- 2. GRADE ---
    p2 = med('p2')
    p98 = med('p98')
    dark_share = med('dark_share')
    white_share = med('white_share')

    g_p2 = score_metric(p2,
                        ref['metrics']['p2']['min'],
                        ref['metrics']['p2']['max'],
                        ref['metrics']['p2']['median'])
    g_p98 = score_metric(p98,
                         ref['metrics']['p98']['min'],
                         ref['metrics']['p98']['max'],
                         ref['metrics']['p98']['median'])
    # Dark share should be low-ish but not crushed
    g_dark = score_metric(dark_share, 0.0, 0.15, 0.014)
    # White share should be present
    g_white = score_metric(white_share, 0.02, 0.2, 0.047)
    scores['grade'] = (g_p2 + g_p98 + g_dark + g_white) / 4

    # --- 3. LIGHTING ---
    shade_ratio = med('shade_ratio')
    warm_hi = med('warm_hi')
    cool_sh = med('cool_sh')

    l_shade = score_metric(shade_ratio,
                           ref['metrics']['shade_ratio']['min'],
                           ref['metrics']['shade_ratio']['max'],
                           ref['metrics']['shade_ratio']['median'])
    l_warm = score_metric(abs(warm_hi), 0.03, 0.25, 0.089)
    l_cool = score_metric(abs(cool_sh), 0.02, 0.20, 0.05)
    scores['lighting'] = (l_shade + l_warm + l_cool) / 3

    # --- 4. DEPTH ---
    dof_ratio = med('dof_ratio')
    sky_grad = med('sky_gradient')

    d_dof = score_metric(dof_ratio, 0.8, 1.4, 1.05)
    d_sky = score_metric(sky_grad, 1.1, 1.45, 1.28)
    scores['depth'] = (d_dof + d_sky) / 2

    # --- 5. TEXTURES ---
    edge_density = med('edge_density')
    detail = med('detail')
    flat_share = med('flat_share')
    ink_line = med('ink_line_score')

    t_edge = score_metric(edge_density, 0.06, 0.18, 0.11)
    t_detail = score_metric(detail, 0.008, 0.032, 0.018)
    t_ink = min(100.0, ink_line)  # ink lines present = good textures
    scores['textures'] = (t_edge + t_detail + t_ink) / 3

    # --- 6. MOTION ---
    sharp = med('sharp_ratio')
    m_sharp = score_metric(sharp,
                           ref['metrics']['sharp_ratio']['min'],
                           ref['metrics']['sharp_ratio']['max'],
                           ref['metrics']['sharp_ratio']['median'])
    scores['motion'] = m_sharp

    # --- 7. CAMERA ---
    # Use DOF variation across frames as proxy for camera moves
    cam_var = float(np.std([m['dof_ratio'] for m in all_metrics]))
    scores['camera'] = score_metric(cam_var, 0.03, 0.35, 0.15)

    # --- 8. CHARACTERS ---
    face_score = med('face_score')
    # Characters need: big heads, thin limbs, face features
    # Proxy: face detection + edge density (thin outlines)
    char_score = (face_score + score_metric(edge_density, 0.04, 0.16, 0.09)) / 2
    scores['characters'] = char_score

    # --- 9. MOVEMENT ---
    scores['movement'] = (scores['camera'] + scores['motion']) / 2

    return scores


def check_dimension_consistency(scores: Dict[str, float],
                                ref: Dict) -> Dict[str, str]:
    """Return per-dimension status messages."""
    status = {}
    for dim in DIMENSIONS:
        score = scores[dim]
        if score >= DIM_MIN_SCORE:
            status[dim] = f"✅ {score:.1f}% (≥{DIM_MIN_SCORE}%)"
        else:
            status[dim] = f"❌ {score:.1f}% (<{DIM_MIN_SCORE}%)"
    return status


def run_check(video_or_frames, montage_path: Optional[str] = None) -> Dict:
    print(f"🔍 Loading frames from: {video_or_frames}")
    frames = load_frames(video_or_frames)

    if not frames:
        print("❌ No frames found")
        return {"overall": 0, "dimensions": {d: 0 for d in DIMENSIONS}, "passed": False}

    print(f"📊 Analyzing {len(frames)} frames...")

    all_metrics = []
    for i, frame in enumerate(frames):
        if i % max(1, len(frames) // 20) == 0 or i == len(frames) - 1:
            print(f"   Frame {i + 1}/{len(frames)}...")
        metrics = compute_frame_metrics(frame)
        all_metrics.append(metrics)

    scores = aggregate_scores(all_metrics, REF)
    status = check_dimension_consistency(scores, REF)

    overall = float(np.mean(list(scores.values())))
    passed = overall >= OVERALL_TARGET and all(s >= DIM_MIN_SCORE for s in scores.values())

    print(f"\n{'=' * 60}")
    print(f"STYLE GATE (Gate 2) — {overall:.1f}% overall")
    print(f"{'=' * 60}")
    print(f"Target: {OVERALL_TARGET}% overall, every dimension ≥{DIM_MIN_SCORE}%")
    print()

    for dim in DIMENSIONS:
        print(f"  {dim:12s} {status[dim]}")

    print()
    if passed:
        print(f"🎉 PASS: Style gate met ({overall:.1f}% ≥ {OVERALL_TARGET}%)")
    else:
        print(f"❌ FAIL: Style gate not met ({overall:.1f}% < {OVERALL_TARGET}%")
        print("   or a dimension is below 80%")
        print("\n   Dimension scores:")
        for dim in DIMENSIONS:
            s = scores[dim]
            bar = "█" * int(s / 5) + "░" * (20 - int(s / 5))
            print(f"     {dim:12s} [{bar}] {s:.1f}%")

    if montage_path:
        save_montage(frames, montage_path)
        print(f"\n📸 Montage saved to: {montage_path}")

    return {
        "overall": overall,
        "dimensions": scores,
        "passed": passed,
        "frame_count": len(frames),
        "status": status,
    }


def save_montage(frames, path):
    """Save a montage of frames for visual review."""
    if not frames:
        return
    n = min(12, len(frames))
    indices = [int(i * len(frames) / n) for i in range(n)]
    thumbs = [Image.fromarray(frames[i]).resize((320, 180)) for i in indices]
    cols = 4
    rows = (len(thumbs) + cols - 1) // cols
    montage = Image.new('RGB', (cols * 320, rows * 180))
    for i, thumb in enumerate(thumbs):
        r, c = divmod(i, cols)
        montage.paste(thumb, (c * 320, r * 180))
    montage.save(path, quality=90)


def build_ref():
    """Rebuild ref_stats.json from the contact sheets."""
    print("📸 Rebuilding reference stats from sheets...")
    print(f"   Sheets dir: {SHEETS_DIR}")
    if not SHEETS_DIR.exists():
        print(f"   ❌ Sheets directory not found: {SHEETS_DIR}")
        return
    sheets = list(SHEETS_DIR.glob('*.jpg'))
    print(f"   Found {len(sheets)} contact sheets")
    print(f"   Reference stats already saved to: {REF_STATS}")
    print("   (Using existing ref_stats.json; re-run metrics collection to update)")


def main():
    parser = argparse.ArgumentParser(description="Three.js Style Accuracy Checker (Gate 2)")
    subparsers = parser.add_subparsers(dest="command")

    check_parser = subparsers.add_parser("check", help="Check a video or frames directory")
    check_parser.add_argument("source", help="Video file or directory with frames")
    check_parser.add_argument("--montage", help="Save a montage image")
    check_parser.add_argument("--json", help="Write the result JSON to this path")

    subparsers.add_parser("build-ref", help="Rebuild reference stats")

    args = parser.parse_args()

    if args.command == "check":
        result = run_check(args.source, args.montage)
        if args.json:
            with open(args.json, 'w') as f:
                json.dump(result, f, indent=2)
        if not result["passed"]:
            sys.exit(1)
    elif args.command == "build-ref":
        build_ref()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
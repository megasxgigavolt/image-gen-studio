"""
YouTube Frame Extractor
=======================
Downloads a YouTube video and extracts one unique frame per second.

Dependencies:
    pip install yt-dlp opencv-python tqdm

Usage:
    python test.py --url "https://youtu.be/VIDEO_ID" [options]
    python test.py --video-id VIDEO_ID [options]
"""

import argparse
import os
import sys
import json
from pathlib import Path


# ── Download video with yt-dlp ────────────────────────────────────────────────
def _ffmpeg_available() -> bool:
    import shutil
    return shutil.which("ffmpeg") is not None


def download_video(url: str, output_path: str, quality: str = None) -> str:
    """Downloads a YouTube video using yt-dlp and returns the local file path."""
    try:
        import yt_dlp
    except ImportError:
        print("[ERROR] yt-dlp not installed. Run: pip install yt-dlp")
        sys.exit(1)

    if quality is None:
        if _ffmpeg_available():
            quality = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"
        else:
            print("[WARN] ffmpeg not found — downloading best pre-merged format. Install ffmpeg for best quality.")
            quality = "best[ext=mp4]/best[ext=webm]/best"

    os.makedirs(output_path, exist_ok=True)
    out_template = os.path.join(output_path, "%(id)s.%(ext)s")

    ydl_opts = {
        "format":              quality,
        "outtmpl":             out_template,
        "quiet":               False,
        "no_warnings":         False,
        "merge_output_format": "mp4",
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        video_id = info.get("id", "video")
        ext = info.get("ext", "mp4")
        downloaded_file = os.path.join(output_path, f"{video_id}.{ext}")

        if not os.path.exists(downloaded_file):
            candidates = list(Path(output_path).glob(f"{video_id}.*"))
            if candidates:
                downloaded_file = str(candidates[0])
            else:
                raise FileNotFoundError(f"Could not locate downloaded file for video ID: {video_id}")

    print(f"\n[INFO] Downloaded: {downloaded_file}")
    return downloaded_file


# ── Frame extraction at 1 fps ─────────────────────────────────────────────────
def extract_frames(
    video_path: str,
    output_dir: str,
    prefix: str = "frame",
    image_format: str = "jpg",
    quality: int = 95,
) -> int:
    """Extracts one frame per second. Returns total frames saved."""
    try:
        import cv2
    except ImportError:
        print("[ERROR] opencv-python not installed. Run: pip install opencv-python")
        sys.exit(1)

    try:
        from tqdm import tqdm
        use_tqdm = True
    except ImportError:
        use_tqdm = False

    os.makedirs(output_dir, exist_ok=True)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise IOError(f"Cannot open video file: {video_path}")

    video_fps    = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_s   = total_frames / video_fps if video_fps > 0 else 0
    frame_step   = max(1, int(round(video_fps)))  # 1 fps

    print(f"\n[INFO] Video: {video_fps:.2f} fps, {total_frames} frames, {duration_s:.1f}s ({duration_s/60:.1f} min)")
    print(f"[INFO] Extracting 1 frame/sec → step={frame_step}, ~{int(duration_s)} frames expected")

    if image_format.lower() == "jpg":
        ext           = ".jpg"
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, quality]
    else:
        ext           = ".png"
        encode_params = [cv2.IMWRITE_PNG_COMPRESSION, 1]

    saved     = 0
    frame_idx = 0

    iterator = range(total_frames)
    if use_tqdm:
        iterator = tqdm(iterator, desc="Extracting frames", unit="frame")

    for _ in iterator:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % frame_step == 0:
            filename = f"{prefix}_{frame_idx:08d}{ext}"
            cv2.imwrite(os.path.join(output_dir, filename), frame, encode_params)
            saved += 1
        frame_idx += 1

    cap.release()
    print(f"\n[INFO] Saved {saved} frames → {output_dir}")
    return saved


# ── Frame deduplication ───────────────────────────────────────────────────────
def deduplicate_frames(frames_dir: str, hash_size: int = 8, threshold: int = 5) -> int:
    """
    Removes visually duplicate frames using difference hashing (dHash).
    Compares each frame to the last kept frame. Returns number of frames removed.
    """
    import cv2
    import numpy as np

    def dhash(img):
        resized = cv2.resize(img, (hash_size + 1, hash_size), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        diff = gray[:, 1:] > gray[:, :-1]
        return diff.flatten()

    frame_files = sorted(
        list(Path(frames_dir).glob("*.jpg")) + list(Path(frames_dir).glob("*.png"))
    )

    if not frame_files:
        return 0

    try:
        from tqdm import tqdm
        frame_files = tqdm(frame_files, desc="Deduplicating", unit="frame")
    except ImportError:
        pass

    last_hash = None
    removed   = 0

    for fpath in frame_files:
        img = cv2.imread(str(fpath))
        if img is None:
            continue
        h = dhash(img)
        if last_hash is not None and int(np.count_nonzero(h != last_hash)) <= threshold:
            os.remove(str(fpath))
            removed += 1
        else:
            last_hash = h

    return removed


# ── Save metadata sidecar ─────────────────────────────────────────────────────
def save_metadata(output_dir: str, info: dict):
    path = os.path.join(output_dir, "_metadata.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(info, f, indent=2, ensure_ascii=False)
    print(f"[INFO] Metadata saved → {path}")


# ── CLI ───────────────────────────────────────────────────────────────────────
def parse_args():
    parser = argparse.ArgumentParser(
        description="Download a YouTube video and extract one unique frame per second.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--url",      help="Full YouTube URL")
    src.add_argument("--video-id", help="YouTube video ID (e.g. dQw4w9WgXcQ)")

    parser.add_argument("--output", "-o", default="./youtube_frames",
                        help="Root output directory (default: ./youtube_frames)")
    parser.add_argument("--keep-video", action="store_true",
                        help="Keep the downloaded video file after extraction")

    parser.add_argument("--no-dedup", action="store_true",
                        help="Skip duplicate frame removal")
    parser.add_argument("--dedup-threshold", type=int, default=5, metavar="N",
                        help="Max perceptual hash distance to treat frames as duplicates (default: 5, range 0-64)")

    parser.add_argument("--format", choices=["jpg", "png"], default="jpg",
                        help="Output image format (default: jpg)")
    parser.add_argument("--quality", type=int, default=95,
                        help="JPEG quality 0-100 (default: 95, ignored for PNG)")
    parser.add_argument("--prefix", default="frame",
                        help="Filename prefix for saved frames (default: frame)")
    parser.add_argument("--download-quality", default=None,
                        help="yt-dlp format selector (default: auto-detected based on ffmpeg availability)")

    return parser.parse_args()


def main():
    args = parse_args()

    if args.video_id:
        url      = f"https://www.youtube.com/watch?v={args.video_id}"
        video_id = args.video_id
    else:
        url = args.url
        import re
        m        = re.search(r"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})", url)
        video_id = m.group(1) if m else "video"

    video_dir  = os.path.join(args.output, video_id)
    frames_dir = os.path.join(video_dir, "frames")

    print("=" * 60)
    print(f" YouTube Frame Extractor")
    print("=" * 60)
    print(f" Video ID : {video_id}")
    print(f" URL      : {url}")
    print(f" Output   : {frames_dir}")
    print("=" * 60)

    print("\n[STEP 1/3] Downloading video...")
    os.makedirs(video_dir, exist_ok=True)
    video_file = download_video(url, video_dir, quality=args.download_quality)

    print("\n[STEP 2/3] Extracting frames at 1 fps...")
    saved = extract_frames(
        video_path=video_file,
        output_dir=frames_dir,
        prefix=args.prefix,
        image_format=args.format,
        quality=args.quality,
    )

    print(f"\n[STEP 3/3] Removing duplicate frames (threshold={args.dedup_threshold})...")
    if not args.no_dedup:
        removed = deduplicate_frames(frames_dir, threshold=args.dedup_threshold)
        saved  -= removed
        print(f"[INFO] Removed {removed} duplicates — {saved} unique frames kept")
    else:
        print("[INFO] Skipping deduplication (--no-dedup)")

    if not args.keep_video:
        os.remove(video_file)
        print(f"[INFO] Removed video file: {video_file}")

    save_metadata(video_dir, {
        "url":             url,
        "video_id":        video_id,
        "unique_frames":   saved,
        "frames_dir":      frames_dir,
        "image_format":    args.format,
        "jpeg_quality":    args.quality,
        "dedup_threshold": args.dedup_threshold,
    })

    print("\n" + "=" * 60)
    print(f" Done! {saved} unique frames saved to:")
    print(f"   {frames_dir}")
    print("=" * 60)


if __name__ == "__main__":
    main()

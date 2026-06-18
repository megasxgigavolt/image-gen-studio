import sys
import re
import os
import json
import urllib.request
from datetime import timedelta

try:
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
    _api = YouTubeTranscriptApi()
except ImportError:
    print("Missing dependency. Run: pip install youtube-transcript-api")
    sys.exit(1)


def extract_video_id(url: str) -> str:
    patterns = [
        r"(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    raise ValueError(f"Could not extract video ID from: {url}")


def get_video_title(video_id: str) -> str:
    oembed_url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
    try:
        with urllib.request.urlopen(oembed_url, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data.get("title", video_id)
    except Exception:
        return video_id


def sanitize_filename(name: str) -> str:
    sanitized = re.sub(r'[<>:"/\\|?*]', '', name)
    sanitized = sanitized.strip('. ')
    return sanitized[:200] or "untitled"


def format_timestamp(seconds: float) -> str:
    td = timedelta(seconds=int(seconds))
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def get_transcript(url: str, language: str = "en") -> list[dict]:
    video_id = extract_video_id(url)
    try:
        fetched = _api.fetch(video_id, languages=[language])
    except NoTranscriptFound:
        transcript_list = _api.list(video_id)
        fetched = transcript_list.find_generated_transcript(
            list(transcript_list._generated_transcripts.keys())
        ).fetch()
    return [{"start": s.start, "text": s.text} for s in fetched]


def print_transcript(transcript: list[dict]) -> None:
    for entry in transcript:
        ts = format_timestamp(entry["start"])
        text = entry["text"].replace("\n", " ")
        print(f"[{ts}] {text}")


def save_transcript(transcript: list[dict], output_file: str) -> None:
    with open(output_file, "w", encoding="utf-8") as f:
        for entry in transcript:
            ts = format_timestamp(entry["start"])
            text = entry["text"].replace("\n", " ")
            f.write(f"[{ts}] {text}\n")
    print(f"  Saved: {output_file}")


def process_links_file(links_file: str, output_dir: str = "transcripts", language: str = "en") -> None:
    with open(links_file, "r", encoding="utf-8") as f:
        urls = [line.strip() for line in f if line.strip()]

    os.makedirs(output_dir, exist_ok=True)
    print(f"Processing {len(urls)} URL(s) -> {output_dir}/\n")

    for i, url in enumerate(urls, 1):
        print(f"[{i}/{len(urls)}] {url}")
        try:
            video_id = extract_video_id(url)
            title = get_video_title(video_id)
            print(f"  Title: {title}")
            output_file = os.path.join(output_dir, f"{sanitize_filename(title)}.txt")
            transcript = get_transcript(url, language)
            save_transcript(transcript, output_file)
        except TranscriptsDisabled:
            print("  Skipped: transcripts are disabled for this video.")
        except ValueError as e:
            print(f"  Skipped: {e}")
        except Exception as e:
            print(f"  Error: {e}")


if __name__ == "__main__":
    # Batch mode: no args, or first arg is a .txt file (not a URL)
    first_arg = sys.argv[1] if len(sys.argv) >= 2 else None
    is_url = first_arg and (first_arg.startswith("http") or re.fullmatch(r"[A-Za-z0-9_-]{11}", first_arg))

    if not is_url:
        links_file = first_arg or "links to analyze.txt"
        output_dir = sys.argv[2] if len(sys.argv) >= 3 else "transcripts"
        language = sys.argv[3] if len(sys.argv) >= 4 else "en"
        process_links_file(links_file, output_dir, language)
    else:
        # Single URL mode
        url = sys.argv[1]
        output_file = sys.argv[2] if len(sys.argv) > 2 else None
        language = sys.argv[3] if len(sys.argv) > 3 else "en"

        try:
            transcript = get_transcript(url, language)
            if output_file:
                save_transcript(transcript, output_file)
            else:
                print_transcript(transcript)
        except TranscriptsDisabled:
            print("Error: Transcripts are disabled for this video.")
            sys.exit(1)
        except ValueError as e:
            print(f"Error: {e}")
            sys.exit(1)
        except Exception as e:
            print(f"Error: {e}")
            sys.exit(1)

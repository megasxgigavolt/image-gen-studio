"""
Cat Analyze — Image Generation Automation  (Nano Banana 2 edition)
Model: imagen-4.0-fast-generate-001  (Imagen 4 Fast on Vertex AI)

Install dependencies once in VS Code terminal:
  pip install google-genai google-auth Pillow tqdm

One-time setup:
  1. Create GCP project with Organization = "No organization"
  2. Enable Vertex AI API + Google Drive API
  3. Create service account → download JSON key → place next to this script
  4. Share your Drive folder with the service account email
  5. Fill in CONFIG below → DRY_RUN = True → press F5 to verify
  6. DRY_RUN = False → press F5 to generate all images
"""

# ══════════════════════════════════════════════════════════════════════════════
#  CONFIG  —  edit these 3 lines, then press F5
# ══════════════════════════════════════════════════════════════════════════════

SA_KEY_FILE     = "runtime/beneath-the-fins-843aa8608070.json"
DRIVE_FOLDER_ID = "1mowfSfDJoAETKO-Wf7Xq_2T-QvKzcwjm"  # unused — saving locally now
GCP_PROJECT_ID  = "beneath-the-fins"
OUTPUT_DIR      = "generated_images"   # folder created next to this script

GCP_REGION   = "global"
PROMPTS_FILE = "Cat_Analyze_Nano_Banana_74_Balanced_Style_Final.txt"

START_INDEX = 1      # first still  (1 = beginning)
END_INDEX   = None   # last still   (None = all)

DRY_RUN    = False   # True = parse & list only, zero API calls
DELAY_SECS = 0       # retry logic handles quota errors automatically
VARIATIONS = 1       # images per prompt (1 = single file s1.png, >1 = s1.1.png, s1.2.png, …)

# ══════════════════════════════════════════════════════════════════════════════
#  END CONFIG
# ══════════════════════════════════════════════════════════════════════════════

import json
import os
import re
import sys
import time
from pathlib import Path

from google.oauth2 import service_account
from google.auth.transport.requests import Request
from google import genai
from google.genai import types
from tqdm import tqdm


# ──────────────────────────────────────────────────────────────────────────────
# PROMPT PARSER
# ──────────────────────────────────────────────────────────────────────────────

DIVIDER_RE   = re.compile(r"^─{10,}", re.MULTILINE)
STILL_HDR_RE = re.compile(r"^STILL\s+(\w+)", re.IGNORECASE)
VO_RE        = re.compile(r'VO:\s*".*?"', re.DOTALL)


def parse_prompts(filepath: str) -> list[dict]:
    text   = Path(filepath).read_text(encoding="utf-8")
    blocks = DIVIDER_RE.split(text)
    prompts = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines, header_line, body_lines, found = block.splitlines(), "", [], False
        for line in lines:
            stripped = line.strip()
            if not found:
                if STILL_HDR_RE.match(stripped):
                    header_line = stripped
                    found = True
                continue
            body_lines.append(line)
        if not found:
            continue
        m        = STILL_HDR_RE.match(header_line)
        still_id = m.group(1) if m else str(len(prompts) + 1)
        body     = VO_RE.sub("", "\n".join(body_lines)).strip()
        if not body:
            continue
        prompts.append({
            "id":     still_id,
            "index":  len(prompts) + 1,
            "header": header_line,
            "prompt": body,
        })
    return prompts


# ──────────────────────────────────────────────────────────────────────────────
# IMAGEN 4 FAST  —  imagen-4.0-fast-generate-001 via google-genai SDK
# ──────────────────────────────────────────────────────────────────────────────

def init_nb2_client():
    """
    Returns a google.genai.Client authenticated via service account,
    pointed at Vertex AI.
    """
    creds = service_account.Credentials.from_service_account_file(
        SA_KEY_FILE,
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(Request())

    client = genai.Client(
        vertexai=True,
        project=GCP_PROJECT_ID,
        location="global",  # Keep this global to map to the global asset pool
        credentials=creds,
    )
    return client

def generate_image(client, prompt: str, retries: int = 5) -> bytes | None:
    for attempt in range(1, retries + 1):
        try:
            # Change from flash to the Pro-tier thinking image engine
            response = client.models.generate_content(
                model="publishers/google/models/gemini-3.1-flash-image",  # <-- Nano Banana Pro
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                    image_config=types.ImageConfig(
                        aspect_ratio="16:9",
                    )
                ),
            )
            
            # Pull the image data from the response candidates
            if response.candidates and response.candidates[0].content.parts:
                for part in response.candidates[0].content.parts:
                    if part.inline_data and part.inline_data.data:
                        return part.inline_data.data
                        
            tqdm.write(f"  ⚠  Attempt {attempt}: No image data returned.")
            return None

        except Exception as exc:
            is_quota = "429" in str(exc) or "RESOURCE_EXHAUSTED" in str(exc)
            wait = 10 if is_quota else 2 ** attempt
            tqdm.write(f"  ⚠  Attempt {attempt} failed: {exc}. Retrying in {wait}s…")
            time.sleep(wait)
    return None

# ──────────────────────────────────────────────────────────────────────────────
# LOCAL SAVE
# ──────────────────────────────────────────────────────────────────────────────

def save_locally(filename: str, image_bytes: bytes) -> str:
    out_dir = Path(OUTPUT_DIR)
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / filename
    out_path.write_bytes(image_bytes)
    return str(out_path)


# ──────────────────────────────────────────────────────────────────────────────
# RESUME STATE
# ──────────────────────────────────────────────────────────────────────────────

STATE_FILE = "runtime/generation_state.json"


def load_state() -> dict:
    if Path(STATE_FILE).exists():
        return json.loads(Path(STATE_FILE).read_text())
    return {"completed": {}}


def save_state(state: dict):
    Path(STATE_FILE).write_text(json.dumps(state, indent=2))


# ──────────────────────────────────────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────────────────────────────────────

def main():

    # ── Config validation ─────────────────────────────────────────────────────
    errors = []
    if not Path(SA_KEY_FILE).exists():
        errors.append(f"Key file not found: '{SA_KEY_FILE}' — place it in the same folder as this script")
    if not Path(PROMPTS_FILE).exists():
        errors.append(f"Prompts file not found: '{PROMPTS_FILE}' — place it in the same folder as this script")
    if errors:
        print("\n❌  Fix these before running:\n")
        for e in errors:
            print(f"   • {e}")
        sys.exit(1)

    # ── Parse ─────────────────────────────────────────────────────────────────
    print(f"\n📄 Parsing: {PROMPTS_FILE}")
    all_prompts = parse_prompts(PROMPTS_FILE)
    print(f"   {len(all_prompts)} prompts found.")

    end_idx = END_INDEX or len(all_prompts)
    prompts = [p for p in all_prompts if START_INDEX <= p["index"] <= end_idx]

    if not prompts:
        print("No prompts in specified range. Check START_INDEX / END_INDEX.")
        sys.exit(0)

    print(f"   Running stills {prompts[0]['index']} → {prompts[-1]['index']}  ({len(prompts)} total)\n")

    # ── Dry run ───────────────────────────────────────────────────────────────
    if DRY_RUN:
        print(f"{'IDX':>4}  {'STILL ID':>8}  HEADER")
        print("─" * 72)
        for p in prompts:
            print(f"  s{p['index']:<3}  STILL {p['id']:<6}  {p['header'][:56]}")

        dry_run_file = Path("dry_run_prompts.txt")
        lines_out = []
        for p in prompts:
            lines_out.append(f"{'─' * 72}")
            lines_out.append(f"s{p['index']}  |  {p['header']}")
            lines_out.append(f"{'─' * 72}")
            lines_out.append(p["prompt"])
            lines_out.append("")
        dry_run_file.write_text("\n".join(lines_out), encoding="utf-8")
        print(f"\n📝  Parsed prompts written to: {dry_run_file.resolve()}")
        print(f"✅  Dry run complete — {len(prompts)} prompts parsed correctly.")
        print(f"    Set DRY_RUN = False and press F5 to start generating.")
        return

    # ── Init clients ──────────────────────────────────────────────────────────
    print("🖼  Connecting to Imagen 4 Fast (imagen-4.0-fast-generate-001) …")
    nb2_client = init_nb2_client()
    print("   ✓ Imagen 4 Fast ready")

    Path(OUTPUT_DIR).mkdir(exist_ok=True)
    print(f"💾 Images will be saved to: {Path(OUTPUT_DIR).resolve()}\n")

    # ── Resume check ──────────────────────────────────────────────────────────
    state     = load_state()
    completed = state["completed"]

    def make_key(index, var):
        return f"s{index}.{var}" if VARIATIONS > 1 else f"s{index}"

    skipped = sum(
        1 for p in prompts
        for var in range(1, VARIATIONS + 1)
        if make_key(p["index"], var) in completed
    )
    if skipped:
        print(f"ℹ  Resume detected — {skipped} images already done, skipping.\n")

    # ── Generation loop ───────────────────────────────────────────────────────
    gen_errors = []

    with tqdm(
        total=len(prompts) * VARIATIONS,
        unit="img",
        colour="cyan",
        bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt}  [{elapsed}<{remaining}  {rate_fmt}]"
    ) as pbar:

        for p in prompts:
            for var in range(1, VARIATIONS + 1):
                key      = make_key(p["index"], var)
                filename = f"{key}.png"
                pbar.set_description(f"{key:>6} | STILL {p['id']:<5}")

                if key in completed:
                    pbar.set_postfix_str("skipped")
                    pbar.update(1)
                    continue

                img_bytes = generate_image(nb2_client, p["prompt"])

                if img_bytes is None:
                    tqdm.write(f"  ✗  {key} (STILL {p['id']}) — generation failed after retries.")
                    gen_errors.append(key)
                    pbar.set_postfix_str("FAILED")
                    pbar.update(1)
                    time.sleep(DELAY_SECS)
                    continue

                try:
                    out_path = save_locally(filename, img_bytes)
                    completed[key] = out_path
                    save_state(state)
                    pbar.set_postfix_str("✓  saved")
                except Exception as exc:
                    tqdm.write(f"  ✗  {key} save error: {exc}")
                    gen_errors.append(key)
                    pbar.set_postfix_str("SAVE ERR")

                pbar.update(1)
                time.sleep(DELAY_SECS)

    # ── Summary ───────────────────────────────────────────────────────────────
    success = len(completed) - skipped
    print(f"\n{'─' * 55}")
    print(f"✅  Generated & uploaded : {success}")
    print(f"⏭   Skipped (already done): {skipped}")
    if gen_errors:
        print(f"❌  Failed               : {len(gen_errors)}")
        print(f"    Failed stills: {', '.join(gen_errors)}")
        print(f"    Re-run — completed stills skip automatically.")
    print(f"{'─' * 55}")
    print(f"📁  Output folder: {Path(OUTPUT_DIR).resolve()}")
    print(f"💾  State: {Path(STATE_FILE).resolve()}\n")


if __name__ == "__main__":
    main()

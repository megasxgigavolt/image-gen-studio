# Image Gen Studio — Changelog

## [v1.1.0] — 2026-06-16 — Bulk Generate Dialog

### Features
- **New Bulk Generate popup window** — replaces the single sidebar button
  - Full cream/brown theme matching main frontend (Segoe UI bold, `#FAF5EC` background)
  - All image-setting dropdowns (Art Style, Camera Angle, Mood, Lighting, Color Palette, DoF, Extra Notes) each with a **"Let AI Decide"** option as the first choice — when selected, Gemini is instructed to pick the most visually appropriate value for each scene
  - **Auto-Generate Style Prompt** button calls GPT-4o on the first 12 still voiceovers to write a cohesive system prompt; fully editable before generation
  - **Reference image upload** — browsed image is sent as base64 alongside the system prompt
  - No chat interface in the popup — focused on bulk settings only
  - **Elapsed time + ETA display** — live 1-second timer showing `Elapsed: MM:SS | ETA: MM:SS`, calculated from actual per-still generation rate
  - **Progress bar** fills as each still is generated
  - **Stop Generation** button cancels gracefully mid-run
  - On next open, if pending images exist from a stopped run: popup asks **"Resume?"** (skip already-generated) or **"Start Over?"** (clear pending and regenerate all)
- **Bulk Approve & Save** available both in the popup and as a sidebar button — saves all pending images to disk in one click, auto-increments version numbers
- **Bug fix — bulk generate skipping stills**: old code re-targeted stills already in `_pending_images`; new dialog correctly skips both `completed` and `pending` stills, offering resume-or-start-over instead
- Per-still errors are collected and shown in a summary dialog at the end rather than silently overwriting the progress label

### Changes
- Sidebar now shows **"Bulk Generate…"** (opens dialog) + **"Bulk Approve & Save All"** buttons
- `_bulk_running` / `_bulk_cancel` state removed from `ImageGenStudio` — all bulk state now lives in the dialog instance
- `_populate_stills_list` no longer guards the progress label update on `_bulk_running`; label clears when no pending images remain

## [v1.0.0] — 2026-06-16 — Initial Release

### Features
- Load Visual Plan Excel file — filters STILL rows, extracts timestamp / duration / voiceover
- Left sidebar with still cards showing voiceover preview and status icons
  - `✓` green = approved & saved to disk
  - `*` amber = pending (generated, awaiting approval)
  - Selected still highlighted with accent border
- Per-still independent GPT-4o chat for prompt suggestions
  - System prompt configurable in settings
  - Reference image support (sent as base64 to GPT)
  - Chat history preserved per still when switching
  - Reset Chat button per still
- Image settings panel: Art Style, Camera Angle, Mood, Lighting, Color Palette, Depth of Field, Extra Notes
- Settings persist across sessions (saved to `settings.json` on close)
- Image generation via Google Gemini (`gemini-3.1-flash-image`) on Vertex AI — 16:9 output
- Generated image fills the panel width dynamically via `after_idle` frame-dimension read
- Approve & Save flow — saves as `s{id}_v{n}.png` with auto-incrementing version
- **Bulk Generate All** — generates all unapproved stills sequentially in background
  - Live progress indicator
  - Stop button cancels mid-run
  - All results held as pending in memory
- Pending images retained per still until approved or regenerated
  - Switching to any still instantly shows its pending image
  - Still cards show pending count in header
- Resume / start-fresh popup if `generation_state.json` found on launch
- Output folder configurable and remembered

### Bug Fixes (pre-release hardening)
- Thread safety: GPT suggestion, chat refinement, and bulk generation workers now snapshot all tkinter widget values in the main thread before starting background threads
- `chat_history` mutations moved to main thread via callbacks (`_apply_suggestion`, `_apply_refinement`)
- Auto GPT suggestion skipped when clicking a still that already has a pending image
- Auto GPT suggestion silently skips (no popup) if no API key configured
- Bulk gen progress label no longer overwritten by `_populate_stills_list` during active generation
- After approve, preview resets to confirmation message instead of showing stale image
- `_gen_error` button text corrected to `"Generate Image"`
- Output dir setting always restored from `settings.json` regardless of whether path exists

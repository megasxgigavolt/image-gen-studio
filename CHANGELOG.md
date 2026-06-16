# Image Gen Studio — Changelog

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

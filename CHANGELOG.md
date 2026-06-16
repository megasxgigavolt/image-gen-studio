# Image Gen Studio — Changelog

## [v1.5.0] — 2026-06-16 — Style accuracy, prompt structure, inline Extract Settings

### Features
- **"Comic Book / Illustration"** added to Art Style dropdown — allows accurate extraction and explicit selection of hand-drawn illustration / comic art styles.
- **Extract Settings button** is now inline with the "What to pick" entry field (right-aligned, maroon, labelled "Extract Settings") in both the main frontend and the Bulk dialog — no separate row.
- **Reference image sent directly to Gemini** during bulk generation — Gemini now receives the actual image alongside the text prompt so it can visually match the style, rather than relying on a textual hint.

### Improvements
- **Extraction accuracy**: GPT receives a system message enforcing exact string matching; `style_prompt` is instructed to write direct technique instructions ("Use bold black outlines…") not vague references ("capture the style of…").
- **Auto-Generate system prompt**: Now sends the reference image to GPT (if uploaded) for visual analysis. Output is a pure visual style directive — explicitly describing art technique, line work, coloring, and palette. No more "Create a series of…" openings or "ensure consistency" vagueness.
- **Bulk per-still prompt structure**: Changed from `Scene: {voiceover}` to `{settings}\n\nDepicted scene: {voiceover}` — style settings lead, scene content follows naturally without a boilerplate "Scene:" label.
- **Settings block**: Removed the vague "Reference Image Guidance: From the reference image, use: …" text line — guidance now comes from the actual image being sent to Gemini directly.

## [v1.4.0] — 2026-06-16 — Extract Image Settings, GPT model selector, bulk fixes

### Features
- **"Extract Image Settings from Reference"** button — available in both the main frontend (Reference Image panel) and the Bulk Generate dialog. Sends the uploaded reference image to GPT-4o Vision with a strict JSON instruction to match each setting to the exact dropdown option strings. Populates Art Style, Camera Angle, Mood, Lighting, Color Palette, Depth of Field dropdowns, Extra Notes, and System Prompt from a single click. "What to pick from this reference" guidance is included to focus the extraction.
- **GPT Model selector** in both the main frontend (Image Settings panel, "GPT Model:" row) and the Bulk Generate dialog (System Prompt section, next to Auto-Generate button). Color-coded tier indicator label updates on selection:
  - ● Higher Capacity (green): `gpt-4o`, `gpt-4.1`, `gpt-5`, `gpt-5.1`, `o3`
  - ● Higher Volume (amber): `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5-mini`, `o4-mini`
- All GPT calls (Suggest Prompt, Chat Refine, Auto-Generate System Prompt, Extract Settings) now use the locally selected model.

### Bug fixes
- **First-generation inconsistent art style**: bulk prompt_map now always builds `Scene: {voiceover}\n\n{settings}` from the dialog's settings, never from saved main-frontend prompts that carry conflicting old settings blocks.
- **Bulk generation stopping early**: added 2-second pause between generations to reduce burst rate-limit hits; retry-on-429 already in place.
- `re` module added for robust JSON extraction from model responses (handles markdown-wrapped JSON).

## [v1.3.0] — 2026-06-16 — Bulk settings sync, UI polish

### Features
- **Bulk generation syncs to main frontend**: When a still is generated in bulk, its settings, prompt, and extra notes are stored. Clicking on any bulk-generated still in the sidebar immediately restores:
  - Image settings dropdowns (concrete values; "Let AI Decide" fields are left unchanged)
  - System prompt box
  - Extra notes field
  - Prompt editor (shows the exact prompt sent to Gemini)
  - Chat log entry: "Bulk generated — prompt used: …"
- **Live sync for currently selected still**: If the bulk-generation loop reaches the still you're currently viewing, all of the above updates in real time as the image arrives.
- **Auto-Generate GPT prompt respects ref_desc**: If "What to pick from this reference image?" is filled in the dialog, it is explicitly included in the GPT request so the generated system prompt reflects those specific qualities.
- **Reference image preview only — no filename**: After browsing a reference image in the Bulk dialog, only the thumbnail is shown; the filename label is cleared.
- **Sidebar button text**: Single-line "Bulk Generation Settings" at consistent font size.

## [v1.2.0] — 2026-06-16 — Rate-limit retry, ref-image preview, ref guidance field

### Features
- **429 / RESOURCE_EXHAUSTED retry**: Bulk generation now retries indefinitely on rate-limit errors. Shows a live countdown ("Rate limited on S7 (attempt 2) — retrying in 8s…") and checks the cancel flag every second so Stop still works immediately.
- **Reference image preview in Bulk dialog**: After browsing an image, a thumbnail preview (max 700×160) is shown inside the Reference Image section — no more guessing from the filename alone.
- **"What to pick from this reference image?" field** — mandatory guidance textbox added in both:
  - Main frontend (below the reference image preview panel)
  - Bulk Generate dialog (inside the Reference Image section)
  - When filled and a reference image is uploaded, the guidance text is included in every generated prompt: `"From the reference image, use: <guidance>"`
  - In the main frontend, GPT-4o receives the field value alongside the image: `"From it, use: <guidance>"`
- **Sidebar: single "Bulk Generation / Settings" button** — replaces the two separate "Bulk Generate…" and "Bulk Approve & Save All" buttons. One click opens the full dialog which already contains Bulk Approve & Save.

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

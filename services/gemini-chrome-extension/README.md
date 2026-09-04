# Gemini Bulk Generation (Chrome extension)

Drives your own, already-logged-in `gemini.google.com` tab from a CSV that
Auto Gen Studio's Bulk Generation panel exports, downloading each generated
image so the app's background watcher can import it back into the Images
tab. See the app's Bulk Generation modal — toggle "Export for Gemini Chrome
extension (CSV)" instead of the usual live API generation.

## One-time setup

1. **Point Chrome's own downloads at a known folder.** Open
   `chrome://settings/downloads` and note (or change) the "Location" —
   this extension can only save files inside that folder tree, nothing
   else (`chrome.downloads.download()` has no way to write anywhere else).
2. **Set the same folder in Auto Gen Studio.** Preferences → *Gemini Chrome
   Extension* → *Watch folder* → point it at the exact folder from step 1.
3. **Load this extension unpacked.** `chrome://extensions` → enable
   *Developer mode* (top right) → *Load unpacked* → select this
   `services/gemini-chrome-extension/` folder.
4. **Log into Google** in a normal Chrome tab if you aren't already — the
   extension uses whatever session your browser already has; it doesn't
   manage its own login.

## Running a batch

1. In Auto Gen Studio, open Bulk Generation, select stills, check the CSV
   export toggle, click Generate. It plans via Claude CLI exactly as usual,
   then writes `<watch folder>/gemini-bulk-gen/<request-id>.csv` and toasts
   the path.
2. Click this extension's icon → its popup → choose that CSV file. **Don't
   rename it** — the filename (minus `.csv`) is how the extension knows
   which batch folder to save images into, and how the app's watcher knows
   which request the images belong to.
3. Click **Start**. Keep the browser open. It opens `gemini.google.com/app`,
   types each row's prompt, waits for the image, and downloads it — a fresh
   chat per row, except a row whose CSV `kind` is `edit`, which continues
   the immediately-preceding row's chat with a follow-up refinement
   instead.
4. Back in Auto Gen Studio, the background watcher picks up each downloaded
   image within a few seconds and imports it into the Images tab — no
   action needed there.

## If Gemini's page stops working

`selectors.js` holds every DOM selector this depends on, in one place —
Google can change gemini.google.com's markup at any time, and it isn't tied
to this app's release cycle. Open the real page, inspect the element that
broke (right-click → *Inspect*), update the matching value in
`selectors.js`, then reload this extension from `chrome://extensions` (no
rebuild needed). Two selectors were placeholders from the start and are the
most likely to need a first real value: `sendButton` and `responseImage` —
see the comments in that file.

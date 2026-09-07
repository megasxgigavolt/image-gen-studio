# Gemini Bulk Generation (Chrome extension)

Live-connects to Auto Gen Studio (over `ws://127.0.0.1:47215`, a small
WebSocket server the desktop app runs) and drives your own,
already-logged-in `gemini.google.com` tab on its behalf — no CSV to export
or upload anymore. The app pushes one job at a time; this extension runs
it, downloads the resulting image, and the app's background watcher
imports it into the Images tab in real time.

## One-time setup

1. **Point Chrome's own downloads at a known folder.** Open
   `chrome://settings/downloads` and note (or change) the "Location" —
   this extension can only save files inside that folder tree, nothing
   else (`chrome.downloads.download()` has no way to write anywhere else).
2. **Set the same folder in Auto Gen Studio.** Preferences → *Gemini Chrome
   Extension* → *Watch folder* → point it at the exact folder from step 1.
   Images land directly in this folder (no subfolder).
3. **Load this extension unpacked.** `chrome://extensions` → enable
   *Developer mode* (top right) → *Load unpacked* → select this
   `services/gemini-chrome-extension/` folder. If Chrome disables it citing
   new permissions to review (this version added `alarms` and `debugger`),
   re-enable it from the same page.
4. **Log into Google** in a normal Chrome tab if you aren't already — the
   extension uses whatever session your browser already has; it doesn't
   manage its own login.
5. Click this extension's icon → **Enable Live Connection**. The status
   line should read "Connected" within a couple of seconds, and Auto Gen
   Studio's own connection badge (bottom-right of its window) should flip
   to "🟢 Gemini extension connected". Leave it enabled — it reconnects on
   its own if the connection ever drops.

## Running a batch

1. In Auto Gen Studio, open Bulk Generation, select stills, check
   "Generate via Gemini Chrome extension (live)", click Generate. It plans
   via Claude CLI exactly as usual, then starts pushing rows to this
   extension automatically — nothing to upload.
2. Watch it work: each pushed job opens `gemini.google.com/app` (or
   continues the immediately-preceding job's chat, for a follow-up edit),
   types the prompt, waits for the image, and downloads it. A
   "'Auto Gen Studio — Gemini Bulk Generation' started debugging this
   browser" banner shows on the active tab while a job runs — that's
   expected (see below), not an error. Don't open DevTools on that tab
   while it's running — Chrome only allows one debugger client per tab.
3. Back in Auto Gen Studio, each image appears in the Images tab within a
   few seconds of downloading — no tab switch or refresh needed, even if
   you're looking at a different part of the app when it lands.

The same live connection also serves single-still Generate clicks made in
browser/live mode, not just Bulk Generation batches.

## Why chrome.debugger?

Gemini's send button silently no-ops on a script-driven `.click()` from a
content script (confirmed live: the button reports enabled, but nothing
happens; a real mouse click on the exact same button sends fine) — almost
certainly because it isn't a trusted user gesture, deliberately filtering
out exactly this kind of automation. `chrome.debugger` (the Chrome DevTools
Protocol) is the one way an extension can dispatch input Chrome treats as
genuinely trusted, so `background.js` uses it for both focusing/typing into
the composer (`Input.insertText`) and clicking the send button
(`Input.dispatchMouseEvent`). `content.js` itself never touches the page's
DOM interactively — it only reads element positions/state for
`background.js` to act on, and detects the resulting image afterward.

## If Gemini's page stops working

`selectors.js` holds every DOM selector this depends on, in one place —
Google can change gemini.google.com's markup at any time, and it isn't tied
to this app's release cycle. Open the real page, inspect the element that
broke (right-click → *Inspect*), update the matching value in
`selectors.js`, then reload this extension from `chrome://extensions` (no
rebuild needed — but do this between batches, not mid-job, since reloading
kills the extension's live connection along with whatever was running).
`sendButton` is confirmed (the real `<button aria-label="Send message">`);
`responseImage` (currently a loose `img` guess) is the one selector most
likely to still need a real value — see the comments in that file.

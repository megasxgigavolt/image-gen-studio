// Every DOM selector content.js needs, in one place — a Google markup
// change is a one-file edit here followed by "reload unpacked" in
// chrome://extensions, no rebuild.
//
// CONFIRMED against the real gemini.google.com/app page (live DOM
// inspection): composer, newChatLink, signedOutLink.
// NOT YET CONFIRMED (best-effort placeholders): sendButton, responseImage.
// Open gemini.google.com/app, type a prompt, and inspect the actual send
// control and the generated <img> once one appears, then update those two
// values here.
window.AGS_SELECTORS = {
  // The chat composer — a contenteditable div, not a <textarea>.
  composer: 'div[aria-label="Enter a prompt for Gemini"]',
  // Not yet confirmed live. content.js falls back to pressing Enter in the
  // composer if this selector matches nothing, so an incorrect value here
  // degrades gracefully rather than blocking submission entirely.
  sendButton: 'button[aria-label*="Send" i]',
  // The region a new response (including its generated image) appears in.
  responseContainer: "main",
  // Not yet confirmed live — Gemini may render the result as a plain <img>,
  // a <canvas>, or something wrapped in a custom element; this is a
  // starting guess.
  responseImage: "img",
  // "New chat" — starts a fresh conversation for the next `generate` row.
  newChatLink: 'a[aria-label="New chat"][href="/app"]',
  // Present when the session isn't logged in — the extension can't do
  // anything for a row while this matches; it waits and lets the user sign
  // in in the same tab.
  signedOutLink: 'a[href*="accounts.google.com"]',
};

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
  // CONFIRMED live: a real <button aria-label="Send message"> (containing
  // the "arrow_upward" mat-icon glyph, in case aria-label ever changes and
  // this needs re-deriving). content.js only reads this element's bounding
  // rect and disabled state — background.js is what clicks it, via
  // chrome.debugger, since a script-driven `.click()` here was silently
  // ignored (not a trusted user gesture).
  sendButton: 'button[aria-label="Send message"]',
  // The region a new response (including its generated image) appears in.
  responseContainer: "main",
  // Not yet confirmed live — Gemini may render the result as a plain <img>,
  // a <canvas>, or something wrapped in a custom element; this is a
  // starting guess.
  responseImage: "img",
  // "New chat" — starts a fresh conversation for the next `generate` row.
  newChatLink: 'a[aria-label="New chat"][href="/app"]',
  // CONFIRMED live: the "+" button that opens the upload/tools menu. What
  // happens after clicking it is NOT confirmed — does an <input type="file">
  // already exist in the DOM (just hidden) at this point, or does a menu
  // item ("Upload files" or similar) need a second click first? See
  // background.js's attachFiles — flagged clearly there too.
  attachButton: 'button[aria-label="Upload & tools"]',
  // Candidate "you're signed out" links — content.js further filters these
  // to ones whose label/text actually says "Sign in" (an accounts.google.com
  // href alone also matches signed-in account-switcher links, so the raw
  // href pattern is intentionally broad here and narrowed in content.js).
  // Also ignored entirely whenever the composer is present, since that's a
  // stronger, unambiguous signal of being signed in.
  signedOutLink: 'a[href*="accounts.google.com"]',
};

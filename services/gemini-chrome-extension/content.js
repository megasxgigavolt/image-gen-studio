// Runs inside gemini.google.com/app itself. Driven entirely by messages
// from background.js (chrome.runtime.onMessage/sendResponse — real
// extension messaging, no bridge hack needed here, unlike the earlier
// abandoned embedded-webview approach). Selectors come from selectors.js
// (loaded first, see manifest.json) so a markup change is a one-file edit
// there, not a change here.
//
// This script only READS the page (finds elements, computes their
// bounding rects, checks disabled state, detects the resulting image) —
// it never types into or clicks anything itself. Gemini's send action
// silently no-ops on a script-driven click (confirmed live: a real mouse
// click sends fine, `.click()` from here does not), almost certainly
// because it isn't a trusted user gesture. background.js gets the rects
// this script reports and drives the actual typing/clicking through
// chrome.debugger (Chrome DevTools Protocol), which produces input Chrome
// treats as genuinely trusted.
(function () {
  const SEL = window.AGS_SELECTORS;

  function query(key) {
    try {
      return document.querySelector(SEL[key]);
    } catch (err) {
      return null;
    }
  }

  // A raw `a[href*="accounts.google.com"]` match is not reliable on its
  // own — a signed-in page still carries other accounts.google.com links
  // (the account-switcher menu, "manage your Google Account", "add another
  // account", etc.), so matching the href alone produced false positives
  // on essentially every load. Require the link to actually read "Sign in",
  // and treat a present composer as decisive proof of being signed in
  // regardless of what else matches the href pattern.
  function findSignInLink() {
    const candidates = document.querySelectorAll(SEL.signedOutLink);
    for (const link of candidates) {
      const label = (link.getAttribute("aria-label") || link.textContent || "").trim().toLowerCase();
      if (label.includes("sign in")) return link;
    }
    return null;
  }

  function isSignedOut() {
    if (query("composer")) return false;
    return Boolean(findSignInLink());
  }

  // Set by a "cancelRow" message from background.js (sent when the user
  // hits Stop while a row is actively waiting) and checked on every waitFor
  // tick, so Stop interrupts an in-flight row within one tick instead of
  // only taking effect once it finishes or hits its own timeout.
  let cancelRequested = false;

  // `label` identifies WHICH wait timed out (e.g. "composer",
  // "send-button-enabled", "response-image") — all three call sites used to
  // reject with the same bare "timeout" string, making every failure
  // indistinguishable in the stored `reason` without live debugging.
  function waitFor(predicate, timeoutMs, intervalMs, label) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (cancelRequested) {
          clearInterval(timer);
          reject(new Error("stopped"));
          return;
        }
        if (isSignedOut()) {
          clearInterval(timer);
          reject(new Error("signed-out"));
          return;
        }
        const value = predicate();
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timeout: ${label || "unknown"} (waited ${timeoutMs}ms)`));
        }
      }, intervalMs || 400);
    });
  }

  // Some frameworks use `aria-disabled` instead of (or in addition to) the
  // native `disabled` property/attribute to represent a disabled control —
  // `.disabled` alone would silently read false for those and make a
  // disabled button look clickable.
  function isDisabled(el) {
    return Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
  }

  // `SEL.sendButton` is confirmed to resolve straight to the real <button>
  // right now, but walking up from whatever it matches (in case that ever
  // reverts to just its icon) is cheap insurance — a click needs the real
  // clickable element's bounding rect, not an inner icon's.
  function closestClickable(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (node.tagName === "BUTTON" || node.tagName === "A" || node.getAttribute("role") === "button") {
        return node;
      }
      node = node.parentElement;
    }
    return el;
  }

  function resolveSendButton() {
    const el = query("sendButton");
    return el ? closestClickable(el) : null;
  }

  function rectOf(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // CDP's Input.dispatch*Event coordinates are CSS pixels relative to the
    // viewport — the same space getBoundingClientRect already reports in —
    // so this needs no further conversion.
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  // Resolves to a data: URL for the generated image, regardless of whether
  // Gemini served it as a blob: URL (page-scoped, must be fetched and
  // converted here) or a same-origin https: URL (fetchable directly, but
  // converting it too keeps the one return type simple for background.js).
  async function imageElementToDataUrl(img) {
    const src = img.currentSrc || img.src;
    const response = await fetch(src);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({ dataUrl: String(reader.result), mimeType: blob.type || "image/png" });
      reader.onerror = () => reject(reader.error || new Error("failed to read image blob"));
      reader.readAsDataURL(blob);
    });
  }

  // State threaded across the three request/response round-trips one row
  // needs (prepareRow → [background types+clicks via CDP] → waitSendEnabled
  // → [background clicks send via CDP] → waitForImage). A plain closure
  // variable is fine here — only one row is ever in flight against this
  // tab at a time.
  let responseContainer = null;
  let alreadyPresentImages = null;

  async function prepareRow() {
    cancelRequested = false; // a fresh row on a reused (edit-continuation) tab must not inherit a prior cancel
    await waitFor(() => query("composer"), 20000, 400, "composer");
    responseContainer = query("responseContainer") || document.body;
    alreadyPresentImages = new Set(responseContainer.querySelectorAll(SEL.responseImage));
    return { composerRect: rectOf(query("composer")) };
  }

  async function waitSendEnabled() {
    const button = resolveSendButton();
    // 4000ms was too tight — observed live: most rows in a batch enable
    // well within that, but an occasional one takes just a bit longer
    // (page/network jitter, not a real failure) and fails the whole row
    // with "timeout" for no good reason. Padded out since a few extra
    // seconds of waiting costs nothing on a row that's actually fine.
    await waitFor(() => (button && !isDisabled(button) ? true : null), 10000, 150, "send-button-enabled");
    // Re-read the rect now rather than reusing one from prepareRow() — cheap,
    // and avoids clicking a stale position if anything shifted meanwhile.
    return { sendButtonRect: rectOf(button) };
  }

  // Only reports the attach button's rect — background.js does the actual
  // clicking (CDP) and, separately, locates/fills the real <input
  // type="file"> entirely through the CDP DOM domain (a raw DOM node
  // reference can't cross from this page context into a CDP session, so
  // there's nothing more content.js can usefully do here for the file
  // input itself).
  function locateAttachButton() {
    return Promise.resolve({ attachButtonRect: rectOf(query("attachButton")) });
  }

  async function waitForImage() {
    const image = await waitFor(() => {
      const candidates = Array.from((responseContainer || document.body).querySelectorAll(SEL.responseImage));
      const fresh = candidates.find((el) => (el.currentSrc || el.src) && !alreadyPresentImages.has(el));
      return fresh || null;
    }, 100000, 500, "response-image");
    // A short settle delay — avoids grabbing a still-streaming/partially
    // decoded image the instant its src first resolves.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return imageElementToDataUrl(image);
  }

  function respond(promise, sendResponse) {
    promise
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) }));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case "cancelRow":
        cancelRequested = true;
        sendResponse({ cancelled: true });
        return true;
      case "prepareRow":
        respond(prepareRow(), sendResponse);
        return true;
      case "waitSendEnabled":
        respond(waitSendEnabled(), sendResponse);
        return true;
      case "waitForImage":
        respond(waitForImage(), sendResponse);
        return true;
      case "locateAttachButton":
        respond(locateAttachButton(), sendResponse);
        return true;
      default:
        return false;
    }
  });
})();

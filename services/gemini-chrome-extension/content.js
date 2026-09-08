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

  // Every wait timeout below scales up with `attempt` (0 on a still's first
  // dispatch, incremented once per automatic retry — see
  // gemini_extension.rs's record_extension_row_failure/dispatch). Confirmed
  // live that a still failing one of these once is meaningfully likely to
  // fail the exact same one again at the exact same fixed budget rather
  // than clearing on pure luck — a retry getting strictly more room, not
  // just another try at the same time budget, is what actually gives a
  // genuinely-slow-but-fine page a real chance to clear on a later attempt.
  function scaledTimeout(base, attempt) {
    return base + (attempt || 0) * base * 0.5;
  }

  async function prepareRow(attempt) {
    cancelRequested = false; // a fresh row on a reused (edit-continuation) tab must not inherit a prior cancel
    await waitFor(() => query("composer"), scaledTimeout(20000, attempt), 400, "composer");
    responseContainer = query("responseContainer") || document.body;
    return { composerRect: rectOf(query("composer")) };
  }

  async function waitSendEnabled(attempt) {
    const button = resolveSendButton();
    try {
      // 4000ms was too tight — observed live: most rows in a batch enable
      // well within that, but an occasional one takes just a bit longer
      // (page/network jitter, not a real failure) and fails the whole row
      // with "timeout" for no good reason. Padded out since a few extra
      // seconds of waiting costs nothing on a row that's actually fine.
      // Padded again, 10000ms -> 15000ms, after confirming live that two
      // fresh-tab rows in a row hit this timeout back-to-back — the actual
      // root cause was a tab-transition race in background.js's runJob
      // (fixed alongside this), but this extra margin costs nothing on a
      // row that's genuinely fine and adds real resilience against
      // whatever page/network jitter remains. Still recurring after both
      // fixes (confirmed live: 3 straight retries on one still all hit
      // this exact timeout at the same fixed 15000ms every time), so this
      // now also grows +50% per retry (15s/22.5s/30s) — see the catch
      // block below for what's needed to actually pin down which of the
      // two known suspects it is next time this happens.
      await waitFor(() => (button && !isDisabled(button) ? true : null), scaledTimeout(15000, attempt), 150, "send-button-enabled");
    } catch (error) {
      // This timeout has recurred even after fixing the one confirmed
      // cause (a tab-transition race) and padding the wait twice — the
      // bare "timed out" reason gives no way to tell apart the two
      // remaining suspects: (a) the composer's typed text never actually
      // registered with Quill's internal model (stays "ql-blank" even
      // though the DOM shows text — a known Quill/CDP race, see
      // background.js's typeText settle delays) vs (b) the text landed
      // fine and Gemini's own page was just genuinely slow to enable the
      // button for some other reason. Attaching this diagnostic to the
      // reason string (which flows all the way back to the row's stored
      // `reason` in the database) is the only way to distinguish them
      // without live DOM inspection next time it recurs.
      const composerEl = query("composer");
      const diagnostic = composerEl
        ? `composerText="${(composerEl.textContent || "").slice(0, 60)}" quillBlank=${composerEl.classList.contains("ql-blank")}`
        : "composer not found at timeout";
      throw new Error(`${error.message} | ${diagnostic}`);
    }
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

  async function waitForImage(attempt) {
    // The "already present" baseline used to be snapshotted back in
    // prepareRow(), BEFORE the message (and, for an edit, its attached
    // source image) was ever sent. That was wrong: `responseImage` (see
    // selectors.js) is deliberately broad ("img" anywhere in
    // responseContainer/"main") because Gemini's actual model-vs-user turn
    // markup isn't confirmed yet — and sending a message with an attached
    // image makes the page immediately echo that attachment as a new <img>
    // in the user's own sent message bubble, well before the model has
    // produced anything. That echoed attachment used to satisfy this
    // function's "any image not already present" check instantly, so an
    // edit-via-extension row downloaded the untouched source image back
    // as if it were the result (confirmed live: byte-identical to the
    // original). A generate row without an attachment mostly got away
    // with it since there's nothing to echo — but the check was fragile
    // either way.
    //
    // Fix: wait long enough for the send to fully render (including any
    // attachment echo in the user's own message) and take the baseline
    // snapshot AFTER that, immediately before polling starts — so "fresh"
    // only ever means "appeared after the user's own message was fully
    // sent," never "the thing I just attached." Gemini's actual image
    // generation reliably takes several seconds at minimum, so this
    // settle window costs nothing on a real response.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const container = responseContainer || document.body;
    const baseline = new Set(container.querySelectorAll(SEL.responseImage));
    const image = await waitFor(() => {
      const candidates = Array.from(container.querySelectorAll(SEL.responseImage));
      const fresh = candidates.find((el) => (el.currentSrc || el.src) && !baseline.has(el));
      return fresh || null;
    }, scaledTimeout(100000, attempt), 500, "response-image");
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
        respond(prepareRow(message.attempt), sendResponse);
        return true;
      case "waitSendEnabled":
        respond(waitSendEnabled(message.attempt), sendResponse);
        return true;
      case "waitForImage":
        respond(waitForImage(message.attempt), sendResponse);
        return true;
      case "locateAttachButton":
        respond(locateAttachButton(), sendResponse);
        return true;
      default:
        return false;
    }
  });
})();

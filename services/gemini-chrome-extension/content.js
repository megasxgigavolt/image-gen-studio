// Runs inside gemini.google.com/app itself. Driven entirely by messages
// from background.js (chrome.runtime.onMessage/sendResponse — real
// extension messaging, no bridge hack needed here, unlike the earlier
// abandoned embedded-webview approach). Selectors come from selectors.js
// (loaded first, see manifest.json) so a markup change is a one-file edit
// there, not a change here.
(function () {
  const SEL = window.AGS_SELECTORS;

  function query(key) {
    try {
      return document.querySelector(SEL[key]);
    } catch (err) {
      return null;
    }
  }

  function isSignedOut() {
    return Boolean(query("signedOutLink"));
  }

  function waitFor(predicate, timeoutMs, intervalMs) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
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
          reject(new Error("timeout"));
        }
      }, intervalMs || 400);
    });
  }

  function insertPrompt(text) {
    const input = query("composer");
    if (!input) throw new Error("composer not found");
    input.focus();
    const inserted = document.execCommand && document.execCommand("insertText", false, text);
    if (!inserted) {
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function submitPrompt() {
    const button = query("sendButton");
    if (button && !button.disabled) {
      button.click();
      return;
    }
    // Fallback: Enter on the composer, in case there's no distinct send
    // button (or the selector needs updating) — degrades gracefully rather
    // than blocking submission outright.
    const input = query("composer");
    if (input) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    }
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

  async function waitForNewImage(container, alreadyPresentImages) {
    const image = await waitFor(() => {
      const candidates = Array.from(container.querySelectorAll(SEL.responseImage));
      const fresh = candidates.find((el) => (el.currentSrc || el.src) && !alreadyPresentImages.has(el));
      return fresh || null;
    }, 100000, 500);
    // A short settle delay — avoids grabbing a still-streaming/partially
    // decoded image the instant its src first resolves.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return image;
  }

  async function runRow(prompt) {
    const container = query("responseContainer") || document.body;
    const alreadyPresentImages = new Set(container.querySelectorAll(SEL.responseImage));

    await waitFor(() => query("composer"), 20000, 400);
    insertPrompt(prompt);
    submitPrompt();

    const image = await waitForNewImage(container, alreadyPresentImages);
    const { dataUrl, mimeType } = await imageElementToDataUrl(image);
    return { ok: true, dataUrl, mimeType };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "runRow") return false;
    runRow(message.prompt)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, reason: String(error && error.message ? error.message : error) }));
    return true; // keep the message channel open for the async response
  });
})();

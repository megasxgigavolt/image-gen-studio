// Service worker — orchestrates one CSV batch, one row at a time. The
// popup sends the whole parsed row list once (startBatch); this file walks
// it, opening/reusing tabs and driving content.js, and reports progress
// back to chrome.storage.local (polled by the popup, since a popup can
// close mid-batch and reopening it shouldn't lose visibility into what's
// happening).
//
// Known v1 limitation: an MV3 service worker can be killed after ~30s of
// no browser-API activity and restarted on the next event. A batch run
// keeps making tabs/downloads calls throughout, which resets that timer in
// practice, but a genuinely very long idle stall inside one row (e.g.
// Gemini itself hanging) could still risk it. Not specially handled here —
// acceptable for an interactively-run v1 tool the user is watching.

const GEMINI_START_URL = "https://gemini.google.com/app";
const STATUS_KEY = "ags_batch_status";

async function setStatus(status) {
  await chrome.storage.local.set({ [STATUS_KEY]: status });
}

async function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function check() {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (tab.status === "complete") {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("tab load timed out"));
          return;
        }
        setTimeout(check, 300);
      });
    }
    check();
  });
}

async function openFreshChatTab() {
  const tab = await chrome.tabs.create({ url: GEMINI_START_URL, active: true });
  await waitForTabComplete(tab.id, 30000);
  // Give the SPA a moment to actually hydrate past "document complete"
  // before the content script's own composer-ready wait takes over.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return tab.id;
}

function sendRunRow(tabId, prompt) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "runRow", prompt }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: "no response from page" });
    });
  });
}

function downloadDataUrl(dataUrl, mimeType, batchId, rowId) {
  const extension = mimeType && mimeType.includes("/") ? mimeType.split("/")[1] : "png";
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename: `gemini-bulk-gen/${batchId}/${rowId}.${extension}`, saveAs: false },
      () => resolve(!chrome.runtime.lastError),
    );
  });
}

async function runBatch(batchId, rows) {
  const results = rows.map((row) => ({ id: row.id, kind: row.kind, status: "pending" }));
  await setStatus({ batchId, running: true, results });

  let currentTabId = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    results[i].status = "running";
    await setStatus({ batchId, running: true, results });

    try {
      if (row.kind !== "edit" || currentTabId === null) {
        if (currentTabId !== null) {
          // Starting a new still's chat — the previous tab's chain (its
          // generate row plus any edit rows) is fully done with.
          chrome.tabs.remove(currentTabId).catch(() => {});
        }
        currentTabId = await openFreshChatTab();
      }
      const response = await sendRunRow(currentTabId, row.prompt);
      if (!response.ok) {
        results[i].status = "failed";
        results[i].reason = response.reason || "unknown error";
      } else {
        const downloaded = await downloadDataUrl(response.dataUrl, response.mimeType, batchId, row.id);
        results[i].status = downloaded ? "done" : "failed";
        if (!downloaded) results[i].reason = "download failed";
      }
    } catch (error) {
      results[i].status = "failed";
      results[i].reason = String(error && error.message ? error.message : error);
    }
    await setStatus({ batchId, running: true, results });
  }

  if (currentTabId !== null) chrome.tabs.remove(currentTabId).catch(() => {});
  await setStatus({ batchId, running: false, results });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "startBatch") {
    runBatch(message.batchId, message.rows);
    sendResponse({ started: true });
    return true;
  }
  return false;
});

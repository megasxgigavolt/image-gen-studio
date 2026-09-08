// Service worker — holds a live WebSocket connection to Auto Gen Studio
// (ws://127.0.0.1:47215) and drives one job at a time as the app pushes
// them, instead of parsing a pre-uploaded CSV. Replaces the old
// popup-upload/Start/Stop/Reset flow: the popup now just toggles this
// connection on/off.
//
// Known v1 limitations:
// - An MV3 service worker can be killed after ~30s of no browser-API
//   activity, which also drops any open WebSocket. `chrome.alarms` (below)
//   periodically checks and reconnects if the user still wants it on — a
//   mitigation, not a guarantee. A job landing exactly during a reconnect
//   gap could stall; the app's own worker loop will just keep retrying to
//   dispatch once the connection is back.
// - Typing/clicking still goes through chrome.debugger (CDP) — confirmed
//   live that Gemini's send button silently ignores a script-driven
//   `.click()` (a real mouse click sends fine), so genuinely-trusted
//   CDP-dispatched input is what's used here, at the cost of a persistent
//   "is debugging this browser" banner on the active tab while a job runs.

const WS_URL = "ws://127.0.0.1:47215";
const ENABLED_KEY = "ags_live_enabled";
const CONNECTED_KEY = "ags_connected";
const LOG_KEY = "ags_recent_log";
const LOG_LIMIT = 20;
const RECONNECT_ALARM = "ags-reconnect";

let socket = null;
// The tab currently open for the in-progress job's chat — persists across
// incoming job messages (not reset per-batch, there is no batch boundary
// in live mode) so an `edit` job can reuse the immediately-preceding
// `generate` job's tab.
let activeTabId = null;

async function setConnected(connected) {
  await chrome.storage.local.set({ [CONNECTED_KEY]: connected });
}

async function appendLog(entry) {
  const data = await chrome.storage.local.get(LOG_KEY);
  const log = [entry, ...(data[LOG_KEY] || [])].slice(0, LOG_LIMIT);
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

function sendMessageOnce(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, reason: "no response from page" });
    });
  });
}

// "Could not establish connection. Receiving end does not exist." means
// content.js hasn't finished loading/registering its listener in this tab
// yet — confirmed live, hit on the very first row of a run (the freshest
// tab, right after chrome.tabs.create's own settle delay). tab.status
// becoming "complete" only means the page loaded, not that a document_idle
// content script has finished injecting — a real, if usually brief, race.
// Retrying a few times costs nothing once the listener is actually up.
async function sendToContent(tabId, message, attemptsLeft = 5) {
  const result = await sendMessageOnce(tabId, message);
  const isMissingReceiver = !result.ok && typeof result.reason === "string"
    && result.reason.toLowerCase().includes("receiving end does not exist");
  if (isMissingReceiver && attemptsLeft > 1) {
    await sleep(400);
    return sendToContent(tabId, message, attemptsLeft - 1);
  }
  return result;
}

// --- chrome.debugger (CDP) input, for genuinely trusted typing/clicking ---

let debuggedTabId = null;

function sendCdpCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

async function ensureDebuggerAttached(tabId) {
  if (debuggedTabId === tabId) return;
  if (debuggedTabId !== null) await detachDebugger(debuggedTabId);
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  debuggedTabId = tabId;
  // DOM.setFileInputFiles (used for edit attachments) needs the DOM
  // domain's node bookkeeping initialized first — Input.* calls don't
  // require this, but DOM.* ones do.
  await sendCdpCommand(tabId, "DOM.enable", {});
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      if (debuggedTabId === tabId) debuggedTabId = null;
      resolve(); // best-effort — already-detached or already-closed tabs are fine
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === debuggedTabId) debuggedTabId = null;
});

async function clickAt(tabId, rect) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sendCdpCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function typeText(tabId, text) {
  await sendCdpCommand(tabId, "Input.insertText", { text });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Finds the real <input type="file"> entirely through CDP's DOM domain — a
// raw DOM node reference from content.js's page context can't cross into a
// CDP session, so this can't be done by asking content.js to look it up.
// UNCONFIRMED LIVE: does this input already exist (just hidden) once the
// "Upload & tools" button reveals its menu, or does an additional click on
// a menu item ("Upload files"/similar) need to happen first? If this
// throws "file input not found", that's exactly what's missing — inspect
// the real menu after clicking the attach button and adjust this function.
async function findFileInputBackendNodeId(tabId) {
  const { root } = await sendCdpCommand(tabId, "DOM.getDocument", { depth: -1, pierce: true });
  const { nodeId } = await sendCdpCommand(tabId, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeId) return null;
  const { node } = await sendCdpCommand(tabId, "DOM.describeNode", { nodeId });
  return node?.backendNodeId || null;
}

// Clicks the attach button (real CDP click — same trusted-input reasoning
// as everything else here) then attaches `paths` (1 or 2 local absolute
// file paths: source image, optionally a mask) to whatever file input
// Chrome reveals. Throws with a clear reason on either step failing, which
// runRowViaDebugger turns into a normal {ok:false} row result rather than
// an uncaught rejection.
async function attachFiles(tabId, paths) {
  const attach = await sendToContent(tabId, { type: "locateAttachButton" });
  if (!attach.ok || !attach.attachButtonRect) throw new Error("attach button not found");
  await clickAt(tabId, attach.attachButtonRect);
  await sleep(500); // let whatever menu/input the button reveals actually render
  const backendNodeId = await findFileInputBackendNodeId(tabId);
  if (!backendNodeId) throw new Error("file input not found after opening the upload menu");
  await sendCdpCommand(tabId, "DOM.setFileInputFiles", { files: paths, backendNodeId });
  await sleep(800); // let Gemini render the attachment thumbnail(s) before we type
}

// One row, start to finish: attach file(s) if this is an edit with a
// source image, focus the composer with a real (CDP) click, insert the
// prompt with real (CDP) text input, wait for Gemini's own send button to
// report enabled, click it for real, then hand back to content.js to
// detect and extract the resulting image.
async function runRowViaDebugger(tabId, prompt, sourceImagePath, maskImagePath, attempt = 0) {
  await ensureDebuggerAttached(tabId);

  if (sourceImagePath) {
    try {
      const paths = maskImagePath ? [sourceImagePath, maskImagePath] : [sourceImagePath];
      await attachFiles(tabId, paths);
    } catch (error) {
      return { ok: false, reason: `attach failed: ${error && error.message ? error.message : error}` };
    }
  }

  const prep = await sendToContent(tabId, { type: "prepareRow", attempt });
  if (!prep.ok) return prep;
  if (!prep.composerRect) return { ok: false, reason: "composer not found" };
  await clickAt(tabId, prep.composerRect);
  // The composer is a Quill.js editor (confirmed live: .ql-editor/.ql-container
  // classes) — clicking to focus it and firing Input.insertText back-to-back
  // occasionally races ahead of Quill's own focus/init handling, landing text
  // that Quill's internal model never registers (stays "ql-blank" even though
  // the DOM shows text), so the send button never reports enabled. A short
  // settle delay before typing, and another after, costs nothing on the rows
  // that were already going to work. `attempt` widens this on a retry (see
  // content.js's own attempt-scaled wait timeouts for the same reasoning) —
  // confirmed live that a still failing this once is meaningfully likely to
  // fail it again at the exact same fixed budget rather than clearing on
  // pure luck, so a retry gets strictly more room, not just another try at
  // the same one.
  await sleep(250 + attempt * 250);
  await typeText(tabId, prompt);
  await sleep(300 + attempt * 300);

  const enabled = await sendToContent(tabId, { type: "waitSendEnabled", attempt });
  if (!enabled.ok) return enabled;
  if (!enabled.sendButtonRect) return { ok: false, reason: "send button not found" };
  await clickAt(tabId, enabled.sendButtonRect);

  return sendToContent(tabId, { type: "waitForImage", attempt });
}

function downloadDataUrl(dataUrl, mimeType, rowId) {
  const extension = mimeType && mimeType.includes("/") ? mimeType.split("/")[1] : "png";
  return new Promise((resolve) => {
    // Flat filename — no per-batch subfolder. Row ids are unique UUIDs, so
    // this can't collide across different batches/videos. conflictAction
    // "overwrite" matters specifically for a retried row (e.g. the app's
    // dispatch ack got lost when a connection dropped mid-job and it
    // re-sent the same row): without it, Chrome's default "uniquify"
    // behavior saves a second attempt as "<id> (1).<ext>", which the app's
    // watcher — matching strictly by filename stem === row id — never
    // recognizes, leaving it a permanently orphaned file and the still
    // stuck without an image.
    chrome.downloads.download(
      { url: dataUrl, filename: `${rowId}.${extension}`, saveAs: false, conflictAction: "overwrite" },
      () => resolve(!chrome.runtime.lastError),
    );
  });
}

const GEMINI_START_URL = "https://gemini.google.com/app";

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

// Runs one job pushed by the app and reports the result back over the
// live connection. Never throws — every failure path resolves to
// {ok:false, reason}, which is what gets sent back and logged.
async function runJob(job) {
  try {
    // A job carrying sourceImagePath (a manual mask-paint Edit dispatched
    // via the extension) always needs its OWN fresh chat, regardless of
    // `kind` — unlike a bulk-planned follow-up-edit (also kind==="edit"),
    // there's no prior turn in whatever tab happens to still be open to
    // continue; the source image only exists as an attachment because
    // there's no such context to inherit it from.
    const needsFreshTab = job.kind !== "edit" || activeTabId === null || Boolean(job.sourceImagePath);
    if (needsFreshTab) {
      if (activeTabId !== null) {
        // Starting a new still's chat — the previous tab's chain (its
        // generate job plus any edit jobs) is fully done with. AWAITED
        // (was previously fire-and-forget): letting the new tab's
        // navigation start while Chrome is still tearing down the old
        // tab's debugger session/process starves the new page's own
        // script execution right as it needs to hydrate and register
        // Quill's send-button-enable logic — confirmed live as two
        // consecutive "timeout: send-button-enabled" failures opening
        // fresh tabs back-to-back with no gap between them.
        await detachDebugger(activeTabId);
        await chrome.tabs.remove(activeTabId).catch(() => {});
        // Small buffer on top of the awaited remove — the callback firing
        // only means Chrome accepted the removal, not that the closed
        // tab's renderer process has fully released CPU/memory yet.
        await sleep(300);
      }
      activeTabId = await openFreshChatTab();
    }
    const response = await runRowViaDebugger(activeTabId, job.prompt, job.sourceImagePath, job.maskImagePath, job.attempt || 0);
    if (!response.ok) return response;
    const downloaded = await downloadDataUrl(response.dataUrl, response.mimeType, job.id);
    return downloaded ? { ok: true } : { ok: false, reason: "download failed" };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
}

function sendResult(id, result) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "result", id, ok: result.ok, reason: result.reason || null }));
}

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  try {
    socket = new WebSocket(WS_URL);
  } catch {
    void setConnected(false);
    return;
  }
  socket.onopen = () => {
    void setConnected(true);
  };
  socket.onclose = () => {
    void setConnected(false);
    socket = null;
  };
  socket.onerror = () => {
    // onclose fires right after in every case observed — no separate
    // handling needed here beyond letting that run.
  };
  socket.onmessage = (event) => {
    let job;
    try {
      job = JSON.parse(event.data);
    } catch {
      return;
    }
    if (job?.type !== "job") return;
    void appendLog({ id: job.id, kind: job.kind, status: "running" }).then(async () => {
      const result = await runJob(job);
      await appendLog({ id: job.id, kind: job.kind, status: result.ok ? "ok" : "failed", reason: result.reason });
      sendResult(job.id, result);
    });
  };
}

function disconnect() {
  if (socket) {
    socket.close();
    socket = null;
  }
  void setConnected(false);
  if (activeTabId !== null) {
    // Interrupt whatever row is actively running right now, if any, rather
    // than leaving it to run to completion after the user has turned the
    // connection off.
    chrome.tabs.sendMessage(activeTabId, { type: "cancelRow" }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "setLiveEnabled") {
    chrome.storage.local.set({ [ENABLED_KEY]: message.enabled }).then(() => {
      if (message.enabled) connect();
      else disconnect();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

// Reconnect check — an MV3 service worker (and any WebSocket it held) can
// be killed after enough idle time; this alarm is what notices the user
// still wants a live connection and re-opens one. `periodInMinutes: 0.5`
// is the practical floor Chrome allows for a recurring alarm.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  chrome.storage.local.get(ENABLED_KEY).then((data) => {
    if (data[ENABLED_KEY] && (!socket || socket.readyState === WebSocket.CLOSED)) connect();
  });
});

// Service worker startup (extension load/reload, or Chrome waking it back
// up) — resume a connection the user had previously enabled.
chrome.storage.local.get(ENABLED_KEY).then((data) => {
  if (data[ENABLED_KEY]) connect();
});

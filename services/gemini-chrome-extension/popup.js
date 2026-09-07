const ENABLED_KEY = "ags_live_enabled";
const CONNECTED_KEY = "ags_connected";
const LOG_KEY = "ags_recent_log";

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const toggleButton = document.getElementById("toggleButton");
const logList = document.getElementById("log");

function renderLog(entries) {
  logList.innerHTML = "";
  for (const entry of entries || []) {
    const li = document.createElement("li");
    li.className = entry.kind === "edit" ? "log-edit" : "log-generate";
    const label = document.createElement("span");
    label.textContent = entry.id.slice(0, 8);
    const status = document.createElement("span");
    status.className = entry.status === "ok" ? "status-ok" : entry.status === "failed" ? "status-failed" : "";
    status.textContent = entry.status === "failed" && entry.reason ? `failed: ${entry.reason}` : entry.status;
    li.appendChild(label);
    li.appendChild(status);
    logList.appendChild(li);
  }
}

function render(data) {
  const enabled = Boolean(data[ENABLED_KEY]);
  const connected = Boolean(data[CONNECTED_KEY]);
  statusEl.className = connected ? "connected" : "disconnected";
  statusEl.firstChild.textContent = connected ? "🟢" : "⚪";
  statusTextEl.textContent = connected ? "Connected" : enabled ? "Enabled — connecting…" : "Not connected";
  toggleButton.textContent = enabled ? "Disable Live Connection" : "Enable Live Connection";
  renderLog(data[LOG_KEY]);
}

toggleButton.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(ENABLED_KEY);
  const nextEnabled = !data[ENABLED_KEY];
  toggleButton.disabled = true;
  chrome.runtime.sendMessage({ type: "setLiveEnabled", enabled: nextEnabled }, () => {
    toggleButton.disabled = false;
  });
});

function refresh() {
  chrome.storage.local.get([ENABLED_KEY, CONNECTED_KEY, LOG_KEY]).then(render);
}
refresh();
setInterval(refresh, 1500);

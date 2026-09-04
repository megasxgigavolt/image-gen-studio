// Minimal RFC4180 CSV parser — prompts are free text and routinely contain
// commas, quotes, and embedded newlines, so naive split(",") would corrupt
// them. Handles quoted fields, doubled-quote escaping, and both \n and
// \r\n line endings.
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r") {
      i += 1;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const fileInput = document.getElementById("csvFile");
const batchLabel = document.getElementById("batchLabel");
const startButton = document.getElementById("startButton");
const rowsList = document.getElementById("rows");

let parsedBatchId = null;
let parsedRows = null;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  parsedBatchId = file.name.replace(/\.csv$/i, "");
  const text = await file.text();
  const table = parseCsv(text);
  const [header, ...dataRows] = table;
  const idIndex = header.indexOf("id");
  const kindIndex = header.indexOf("kind");
  const promptIndex = header.indexOf("prompt");
  if (idIndex === -1 || kindIndex === -1 || promptIndex === -1) {
    batchLabel.textContent = "This doesn't look like a Bulk Generation export (missing id/kind/prompt columns).";
    startButton.disabled = true;
    return;
  }
  parsedRows = dataRows
    .filter((row) => row.length >= 3 && row[idIndex])
    .map((row) => ({ id: row[idIndex], kind: row[kindIndex], prompt: row[promptIndex] }));
  batchLabel.textContent = `Batch ${parsedBatchId} — ${parsedRows.length} row${parsedRows.length === 1 ? "" : "s"}. Downloads will save to gemini-bulk-gen/${parsedBatchId}/ — make sure that matches the app's watch folder.`;
  startButton.disabled = parsedRows.length === 0;
  renderRows(parsedRows.map((row) => ({ id: row.id, kind: row.kind, status: "pending" })));
});

startButton.addEventListener("click", () => {
  if (!parsedBatchId || !parsedRows) return;
  startButton.disabled = true;
  chrome.runtime.sendMessage({ type: "startBatch", batchId: parsedBatchId, rows: parsedRows });
});

function renderRows(results) {
  rowsList.innerHTML = "";
  for (const result of results) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${result.kind === "edit" ? "↳ " : ""}${result.id.slice(0, 8)}`;
    const status = document.createElement("span");
    status.className = `status-${result.status}`;
    status.textContent = result.status === "failed" && result.reason ? `failed: ${result.reason}` : result.status;
    li.appendChild(label);
    li.appendChild(status);
    rowsList.appendChild(li);
  }
}

// Reflects whatever's in progress (or just finished) if the popup is
// reopened mid-batch, and keeps the list live while it's open.
function refreshFromStorage() {
  chrome.storage.local.get("ags_batch_status", (data) => {
    const status = data.ags_batch_status;
    if (!status) return;
    batchLabel.textContent = `Batch ${status.batchId}${status.running ? " — running…" : " — finished"}`;
    renderRows(status.results);
    startButton.disabled = status.running;
  });
}
refreshFromStorage();
setInterval(refreshFromStorage, 1500);

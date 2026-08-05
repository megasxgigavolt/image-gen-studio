import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { projectsClient, type ExportCaptionsMode, type ExportQuality, type ExportResolution } from "./infrastructure/projects-client";

type TestState = "idle" | "testing" | "ok" | "failed";

const RESOLUTIONS: ExportResolution[] = ["720p", "1080p", "2160p"];
const RESOLUTION_LABELS: Record<ExportResolution, string> = { "720p": "720p", "1080p": "1080p", "2160p": "4K" };
const QUALITIES: ExportQuality[] = ["compressed", "balanced", "high"];
const CAPTION_MODES: ExportCaptionsMode[] = ["burned-in", "srt", "both"];
const CAPTION_MODE_LABELS: Record<ExportCaptionsMode, string> = { "burned-in": "Burned-in", srt: "SRT", both: "Both" };

/** Centered Preferences popup — general/AI-provider/export-default settings,
 * all local draft state until "Save". Two settings described in the original
 * spec are intentionally left out rather than faked: auto-save interval
 * (autosave here is reactive-on-edit, not timer-based, so the control
 * wouldn't do anything) and "Check for updates" (this build has no update
 * server to check against). */
export function PreferencesModal({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState("");
  const [saveLocation, setSaveLocation] = useState("");
  const [exportResolution, setExportResolution] = useState<ExportResolution>("1080p");
  const [exportQuality, setExportQuality] = useState<ExportQuality>("balanced");
  const [exportCaptions, setExportCaptions] = useState<ExportCaptionsMode>("burned-in");
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [openaiTest, setOpenaiTest] = useState<TestState>("idle");
  const [geminiTest, setGeminiTest] = useState<TestState>("idle");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const [version, folder, resolution, quality, captions, openaiStatus, geminiStatus] = await Promise.all([
        projectsClient.getApplicationVersion(),
        projectsClient.getAppSetting("download_folder"),
        projectsClient.getAppSetting("export_default_resolution"),
        projectsClient.getAppSetting("export_default_quality"),
        projectsClient.getAppSetting("export_default_captions"),
        projectsClient.getProviderKeyStatus("openai"),
        projectsClient.getProviderKeyStatus("gemini"),
      ]);
      setAppVersion(version);
      setSaveLocation(folder ?? "");
      if (resolution && (RESOLUTIONS as string[]).includes(resolution)) setExportResolution(resolution as ExportResolution);
      if (quality && (QUALITIES as string[]).includes(quality)) setExportQuality(quality as ExportQuality);
      if (captions && (CAPTION_MODES as string[]).includes(captions)) setExportCaptions(captions as ExportCaptionsMode);
      setOpenaiConfigured(openaiStatus.configured);
      setGeminiConfigured(geminiStatus.configured);
      setLoading(false);
    })();
  }, []);

  async function browseSaveLocation() {
    const folder = await projectsClient.pickDownloadFolder();
    if (folder) setSaveLocation(folder);
  }

  async function testKey(provider: "openai" | "gemini") {
    const setTest = provider === "openai" ? setOpenaiTest : setGeminiTest;
    setTest("testing");
    try {
      // A freshly typed, unsaved key can't be tested until it's saved — the
      // native call reads from the OS keyring, not this draft state.
      if (provider === "openai" && openaiKeyDraft.trim()) await projectsClient.saveProviderKey("openai", openaiKeyDraft.trim());
      if (provider === "gemini" && geminiKeyDraft.trim()) await projectsClient.saveProviderKey("gemini", geminiKeyDraft.trim());
      await projectsClient.testProviderKey(provider);
      setTest("ok");
      if (provider === "openai") setOpenaiConfigured(true); else setGeminiConfigured(true);
    } catch {
      setTest("failed");
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await Promise.all([
        projectsClient.saveAppSetting("download_folder", saveLocation),
        projectsClient.saveAppSetting("export_default_resolution", exportResolution),
        projectsClient.saveAppSetting("export_default_quality", exportQuality),
        projectsClient.saveAppSetting("export_default_captions", exportCaptions),
        openaiKeyDraft.trim() ? projectsClient.saveProviderKey("openai", openaiKeyDraft.trim()) : Promise.resolve(),
        geminiKeyDraft.trim() ? projectsClient.saveProviderKey("gemini", geminiKeyDraft.trim()) : Promise.resolve(),
      ]);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function openAppDataFolder() {
    const dir = await projectsClient.getAppDataDir();
    if (dir) await projectsClient.revealInFileManager(dir);
  }

  function testBadge(state: TestState) {
    if (state === "testing") return <span className="pref-test-badge"><LoaderCircle size={13} className="spin" />Testing…</span>;
    if (state === "ok") return <span className="pref-test-badge ok"><CheckCircle2 size={13} />Connected</span>;
    if (state === "failed") return <span className="pref-test-badge failed"><XCircle size={13} />Failed</span>;
    return null;
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal preferences-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="preferences-header">
          <h2>Preferences</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        {loading ? (
          <div className="empty-state compact">Loading preferences…</div>
        ) : (
          <div className="preferences-body">
            <div className="panel-section-heading"><h3>General</h3></div>
            <label className="pref-field">
              <span className="field-heading">Default save location</span>
              <div className="pref-path-row">
                <input type="text" className="tl-text-input" value={saveLocation} readOnly placeholder="System default documents folder" />
                <button type="button" className="secondary" onClick={() => void browseSaveLocation()}><FolderOpen size={14} />Browse</button>
              </div>
            </label>
            <label className="pref-field">
              <span className="field-heading">Language</span>
              <select className="tl-select" value="English" disabled>
                <option>English</option>
              </select>
              <small className="tl-source-hint">More languages are planned — English only for now.</small>
            </label>

            <div className="panel-section-heading" style={{ marginTop: "18px" }}><h3>AI Providers</h3></div>
            <p className="tl-source-hint"><Info size={12} style={{ marginRight: "4px", verticalAlign: "-1px" }} />API keys are stored locally on your machine and never sent to our servers.</p>
            <label className="pref-field">
              <span className="field-heading">Prompt generation (OpenAI)</span>
              <div className="pref-path-row">
                <input
                  type="password"
                  className="tl-text-input"
                  value={openaiKeyDraft}
                  onChange={(event) => setOpenaiKeyDraft(event.target.value)}
                  placeholder={openaiConfigured ? "•••••••••••••••• (saved)" : "sk-…"}
                />
                <button type="button" className="secondary" onClick={() => void testKey("openai")} disabled={openaiTest === "testing" || (!openaiConfigured && !openaiKeyDraft.trim())}>Test</button>
              </div>
              {testBadge(openaiTest)}
            </label>
            <label className="pref-field">
              <span className="field-heading">Image generation &amp; Animation (Gemini)</span>
              <div className="pref-path-row">
                <input
                  type="password"
                  className="tl-text-input"
                  value={geminiKeyDraft}
                  onChange={(event) => setGeminiKeyDraft(event.target.value)}
                  placeholder={geminiConfigured ? "•••••••••••••••• (saved)" : "AIza…"}
                />
                <button type="button" className="secondary" onClick={() => void testKey("gemini")} disabled={geminiTest === "testing" || (!geminiConfigured && !geminiKeyDraft.trim())}>Test</button>
              </div>
              {testBadge(geminiTest)}
              <small className="tl-source-hint">One Gemini key powers both image generation (Visuals) and animation (Animate/Veo) — they share the same credential in this app.</small>
            </label>

            <div className="panel-section-heading" style={{ marginTop: "18px" }}><h3>Export Defaults</h3></div>
            <div className="pref-field">
              <span className="field-heading">Default resolution</span>
              <div className="tl-preset-grid three">
                {RESOLUTIONS.map((value) => (
                  <button key={value} type="button" className={exportResolution === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setExportResolution(value)}><span>{RESOLUTION_LABELS[value]}</span></button>
                ))}
              </div>
            </div>
            <div className="pref-field">
              <span className="field-heading">Default quality</span>
              <div className="tl-preset-grid three">
                {QUALITIES.map((value) => (
                  <button key={value} type="button" className={exportQuality === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setExportQuality(value)}><span style={{ textTransform: "capitalize" }}>{value}</span></button>
                ))}
              </div>
            </div>
            <div className="pref-field">
              <span className="field-heading">Default captions</span>
              <div className="tl-preset-grid three">
                {CAPTION_MODES.map((value) => (
                  <button key={value} type="button" className={exportCaptions === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setExportCaptions(value)}><span>{CAPTION_MODE_LABELS[value]}</span></button>
                ))}
              </div>
            </div>

            <div className="panel-section-heading" style={{ marginTop: "18px" }}><h3>About</h3></div>
            <p className="tl-source-hint">Auto Gen Studio v{appVersion}</p>
            <button type="button" className="secondary" onClick={() => void openAppDataFolder()}><FolderOpen size={14} />Open app data folder</button>
          </div>
        )}
        <div className="footer-actions">
          <button className="secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="primary" onClick={() => void handleSave()} disabled={saving || loading}>{saving ? <><LoaderCircle className="spin" size={14} />Saving…</> : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

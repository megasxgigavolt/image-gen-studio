import { useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Info, LoaderCircle, X, XCircle } from "lucide-react";
import { projectsClient, type ExportCaptionsMode, type ExportResolution } from "./infrastructure/projects-client";
import { useAppStore } from "./store/app-store";

type TestState = "idle" | "testing" | "ok" | "failed";

const RESOLUTIONS: ExportResolution[] = ["720p", "1080p", "2160p"];
const RESOLUTION_LABELS: Record<ExportResolution, string> = { "720p": "720p", "1080p": "1080p", "2160p": "4K" };
// No quality preference — every export always uses the app's own
// best-quality encode (see ExportDrawer's own comment on why).
const CAPTION_MODES: ExportCaptionsMode[] = ["burned-in", "srt", "both"];
const CAPTION_MODE_LABELS: Record<ExportCaptionsMode, string> = { "burned-in": "Burned-in", srt: "SRT", both: "Both" };

type AutosaveInterval = "30s" | "1m" | "2m" | "manual";
const AUTOSAVE_INTERVALS: AutosaveInterval[] = ["30s", "1m", "2m", "manual"];
const AUTOSAVE_INTERVAL_LABELS: Record<AutosaveInterval, string> = { "30s": "30s", "1m": "1 min", "2m": "2 min", manual: "Manual only" };

/** Centered Preferences popup — general/AI-provider/export-default settings,
 * all local draft state until "Save". "Check for updates" from the original
 * spec is intentionally left out rather than faked — this build has no
 * update server to check against. */
export function PreferencesModal({ onClose }: { onClose: () => void }) {
  const [appVersion, setAppVersion] = useState("");
  const [saveLocation, setSaveLocation] = useState("");
  const [geminiWatchFolder, setGeminiWatchFolder] = useState("");
  // Default for both the single-still Generate button (no per-click mode
  // picker of its own) and the Bulk Generation modal's own checkbox (which
  // still keeps a per-request override, just seeded from this).
  const [generationModeDefault, setGenerationModeDefault] = useState<"api" | "browser-live">("api");
  const [autosaveInterval, setAutosaveInterval] = useState<AutosaveInterval>("30s");
  // 1080p — matches what most AI-generated source stills/animations
  // actually are (see ExportSettingsRecord's own default comment); 720p/4K
  // stay one click away here.
  const [exportResolution, setExportResolution] = useState<ExportResolution>("1080p");
  const [exportCaptions, setExportCaptions] = useState<ExportCaptionsMode>("burned-in");
  const [openaiConfigured, setOpenaiConfigured] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [openaiTest, setOpenaiTest] = useState<TestState>("idle");
  const [geminiTest, setGeminiTest] = useState<TestState>("idle");
  const [testMode, setTestMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const addToast = useAppStore((state) => state.addToast);

  useEffect(() => {
    void (async () => {
      const [version, folder, watchFolder, modeDefault, autosave, resolution, captions, testModeSetting, openaiStatus, geminiStatus] = await Promise.all([
        projectsClient.getApplicationVersion(),
        projectsClient.getAppSetting("download_folder"),
        projectsClient.getAppSetting("gemini_extension_watch_folder"),
        projectsClient.getAppSetting("generation_mode_default"),
        projectsClient.getAppSetting("autosave_interval"),
        projectsClient.getAppSetting("export_default_resolution"),
        projectsClient.getAppSetting("export_default_captions"),
        projectsClient.getAppSetting("ai_test_mode"),
        projectsClient.getProviderKeyStatus("openai"),
        projectsClient.getProviderKeyStatus("gemini"),
      ]);
      setAppVersion(version);
      setSaveLocation(folder ?? "");
      setGeminiWatchFolder(watchFolder ?? "");
      if (modeDefault === "browser-live") setGenerationModeDefault("browser-live");
      if (autosave && (AUTOSAVE_INTERVALS as string[]).includes(autosave)) setAutosaveInterval(autosave as AutosaveInterval);
      if (resolution && (RESOLUTIONS as string[]).includes(resolution)) setExportResolution(resolution as ExportResolution);
      if (captions && (CAPTION_MODES as string[]).includes(captions)) setExportCaptions(captions as ExportCaptionsMode);
      setTestMode(testModeSetting === "true");
      setOpenaiConfigured(openaiStatus.configured);
      setGeminiConfigured(geminiStatus.configured);
      setLoading(false);
    })();
  }, []);

  async function browseSaveLocation() {
    const folder = await projectsClient.pickDownloadFolder();
    if (folder) setSaveLocation(folder);
  }

  async function browseGeminiWatchFolder() {
    const folder = await projectsClient.pickDownloadFolder();
    if (folder) setGeminiWatchFolder(folder);
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
        projectsClient.saveAppSetting("gemini_extension_watch_folder", geminiWatchFolder),
        projectsClient.saveAppSetting("generation_mode_default", generationModeDefault),
        projectsClient.saveAppSetting("autosave_interval", autosaveInterval),
        projectsClient.saveAppSetting("export_default_resolution", exportResolution),
        projectsClient.saveAppSetting("export_default_captions", exportCaptions),
        projectsClient.saveAppSetting("ai_test_mode", testMode ? "true" : "false"),
        openaiKeyDraft.trim() ? projectsClient.saveProviderKey("openai", openaiKeyDraft.trim()) : Promise.resolve(),
        geminiKeyDraft.trim() ? projectsClient.saveProviderKey("gemini", geminiKeyDraft.trim()) : Promise.resolve(),
      ]);
      addToast("Preferences saved", "success", 2000);
      onClose();
    } catch (error) {
      // Promise.all gives no indication which setting(s) actually failed
      // (some may have partially succeeded) — surface the failure instead of
      // letting it become an unhandled rejection with the modal just
      // silently stopping its spinner. Deliberately no onClose() here so the
      // user can see the error and retry.
      addToast(`Could not save preferences: ${String(error)}`, "error");
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
            <div className="pref-field">
              <span className="field-heading">Auto-save interval</span>
              <div className="tl-preset-grid four">
                {AUTOSAVE_INTERVALS.map((value) => (
                  <button key={value} type="button" className={autosaveInterval === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setAutosaveInterval(value)}><span>{AUTOSAVE_INTERVAL_LABELS[value]}</span></button>
                ))}
              </div>
            </div>

            <div className="panel-section-heading" style={{ marginTop: "18px" }}><h3>AI Providers</h3></div>
            <p className="tl-source-hint"><Info size={12} style={{ marginRight: "4px", verticalAlign: "-1px" }} />API keys are stored locally on your machine and never sent to our servers.</p>
            <div className="pref-toggle-row">
              <span className="field-heading">Test mode</span>
              <label className="pref-switch">
                <input type="checkbox" checked={testMode} onChange={(event) => setTestMode(event.target.checked)} aria-label="Test mode" />
                <span className="pref-switch-track" />
              </label>
            </div>
            <small className="tl-source-hint">Enables offline stubs — no API calls are made. Use during development.</small>
            <label className="pref-field">
              <span className="field-heading">Motion graphics fallback (OpenAI)</span>
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
              <small className="tl-source-hint">Optional — only used as a last-resort fallback for Motion Graphics analysis. Bulk Gen planning uses the Claude Code CLI (if logged in) and Gemini, not OpenAI.</small>
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

            <div className="panel-section-heading" style={{ marginTop: "18px" }}><h3>Gemini Chrome Extension</h3></div>
            <label className="pref-field">
              <span className="field-heading">Watch folder</span>
              <div className="pref-path-row">
                <input type="text" className="tl-text-input" value={geminiWatchFolder} readOnly placeholder="Not set — required to export prompts" />
                <button type="button" className="secondary" onClick={() => void browseGeminiWatchFolder()}><FolderOpen size={14} />Browse</button>
              </div>
              <small className="tl-source-hint">Point this at your Chrome browser's own Downloads folder (check chrome://settings/downloads if unsure) — the extension can only save files there, not to a folder chosen per-batch. Images land directly in this folder, no subfolder.</small>
            </label>
            <div className="pref-field">
              <span className="field-heading">Generate images via</span>
              <div className="tl-preset-grid two">
                <button type="button" className={generationModeDefault === "api" ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setGenerationModeDefault("api")}><span>Live API</span></button>
                <button type="button" className={generationModeDefault === "browser-live" ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setGenerationModeDefault("browser-live")}><span>Gemini Chrome extension</span></button>
              </div>
              <small className="tl-source-hint">Default for the single-still Generate button (and the Bulk Generation modal's starting checkbox state). "Gemini Chrome extension" requires Live Connection enabled in the extension's popup — a still just sits waiting until it is.</small>
            </div>

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

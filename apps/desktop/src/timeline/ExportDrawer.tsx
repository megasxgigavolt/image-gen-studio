import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FolderOpen, LoaderCircle, Play, Square, X } from "lucide-react";
import type { ExportCaptionsMode, ExportQuality, ExportResolution, ExportSettingsRecord } from "../infrastructure/projects-client";

type ExportResult = { kind: "success"; path: string } | { kind: "failure"; error: string };

const RESOLUTION_OPTIONS: { value: ExportResolution; label: string }[] = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "2160p", label: "4K" },
];
const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: "compressed", label: "Compressed" },
  { value: "balanced", label: "Balanced" },
  { value: "high", label: "High" },
];
const CAPTIONS_MODE_OPTIONS: { value: ExportCaptionsMode; label: string }[] = [
  { value: "burned-in", label: "Burned-in" },
  { value: "srt", label: "SRT only" },
  { value: "both", label: "Both" },
];

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return minutes > 0 ? `~${minutes}m ${secs}s remaining` : `~${secs}s remaining`;
}

/** Export settings panel that slides in from the right, over the timeline
 * pane but never over the preview — the preview keeps rendering/playing
 * behind it, unlike the old centered export modal it replaces. */
export function ExportDrawer({
  open,
  onClose,
  hasClips,
  hasMusic,
  exporting,
  exportCancelling,
  exportProgress,
  settings,
  onSettingsChange,
  result,
  onStart,
  onCancel,
  onExportAgain,
  onShowInFolder,
  onOpenHistory,
}: {
  open: boolean;
  onClose: () => void;
  hasClips: boolean;
  hasMusic: boolean;
  exporting: boolean;
  exportCancelling?: boolean;
  exportProgress: { percent: number; stage: string; detail: string };
  settings: ExportSettingsRecord;
  onSettingsChange: (patch: Partial<ExportSettingsRecord>) => void;
  result: ExportResult | null;
  onStart: () => void;
  onCancel: () => void;
  onExportAgain: () => void;
  onShowInFolder: (path: string) => void;
  onOpenHistory: () => void;
}) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (exporting) setStartedAt((current) => current ?? Date.now());
    else setStartedAt(null);
  }, [exporting]);

  useEffect(() => {
    if (!exporting) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [exporting]);

  if (!open) return null;

  const percent = Math.max(0, Math.min(100, exportProgress.percent));
  const elapsedSeconds = startedAt ? (now - startedAt) / 1000 : 0;
  const etaSeconds = percent > 2 && percent < 100 ? (elapsedSeconds / percent) * (100 - percent) : NaN;

  return (
    <div className="tl-export-drawer" role="dialog" aria-label="Export video">
      <div className="tl-export-drawer-header">
        <strong><Download size={15} />Export video</strong>
        <button className="tl-icon-btn" onClick={onClose} disabled={exporting} aria-label="Close"><X size={16} /></button>
      </div>

      {result?.kind === "success" && (
        <div className="tl-export-result success">
          <CheckCircle2 size={28} />
          <strong>Export complete</strong>
          <p className="tl-source-hint">{result.path}</p>
          <div className="tl-export-result-actions">
            <button className="secondary" onClick={() => onShowInFolder(result.path)}><FolderOpen size={14} />Show in folder</button>
            <button className="secondary" onClick={onExportAgain}><Play size={14} />Export again</button>
          </div>
          <button className="primary full" onClick={onClose}>Close</button>
        </div>
      )}

      {result?.kind === "failure" && (
        <div className="tl-export-result failure">
          <AlertTriangle size={28} />
          <strong>Export failed</strong>
          <p className="tl-source-hint tl-export-error-text">{result.error}</p>
          <div className="tl-export-result-actions">
            <button className="secondary" onClick={onExportAgain}><Play size={14} />Try again</button>
          </div>
        </div>
      )}

      {!result && (
        <>
          <ul className="tl-export-bullets">
            <li>Renders the whole timeline into a single MP4.</li>
            <li>Includes: stills/animations, narration, captions per the settings below.</li>
            <li>You'll pick a destination before rendering starts.</li>
          </ul>
          {!exporting ? (
            <>
              <div className="tl-inspector-group">
                <span className="tl-inspector-label">Resolution</span>
                <div className="tl-preset-grid three">
                  {RESOLUTION_OPTIONS.map(({ value, label }) => (
                    <button key={value} className={settings.resolution === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => onSettingsChange({ resolution: value })}>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tl-inspector-group">
                <span className="tl-inspector-label">Quality</span>
                <div className="tl-preset-grid three">
                  {QUALITY_OPTIONS.map(({ value, label }) => (
                    <button key={value} className={settings.quality === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => onSettingsChange({ quality: value })}>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tl-inspector-group">
                <span className="tl-inspector-label">Captions</span>
                <div className="tl-preset-grid three">
                  {CAPTIONS_MODE_OPTIONS.map(({ value, label }) => (
                    <button key={value} className={settings.captionsMode === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => onSettingsChange({ captionsMode: value })}>
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="tl-inspector-group">
                <label className="tl-checkbox-row">
                  <input type="checkbox" checked={settings.includeNarration} onChange={(event) => onSettingsChange({ includeNarration: event.target.checked })} />
                  <span>Include narration audio</span>
                </label>
                <label className="tl-checkbox-row">
                  <input type="checkbox" checked={settings.includeMusic} disabled={!hasMusic} onChange={(event) => onSettingsChange({ includeMusic: event.target.checked })} />
                  <span>Include background music{!hasMusic && " (no music on timeline)"}</span>
                </label>
              </div>
              <button className="secondary full" onClick={onOpenHistory}><Clock size={14} />Export history</button>
              <button className="primary full" disabled={!hasClips} onClick={onStart}><Play size={15} />Start export</button>
            </>
          ) : (
            <div className="tl-export-progress">
              <div className="progress-heading">
                <LoaderCircle className="spin" size={22} />
                <strong>{exportCancelling ? "Cancelling…" : exportProgress.stage}</strong>
                {!exportCancelling && <b>{percent}%</b>}
              </div>
              <span>{exportCancelling ? "Stopping the export engine…" : (exportProgress.detail || "Starting the export engine…")}</span>
              {!exportCancelling && Number.isFinite(etaSeconds) && <span className="tl-export-eta">{formatEta(etaSeconds)}</span>}
              <div className="loading-bar determinate"><i style={{ width: `${percent}%` }} /></div>
              <button className="secondary full" disabled={exportCancelling} onClick={onCancel}><Square size={13} />{exportCancelling ? "Cancelling…" : "Stop"}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

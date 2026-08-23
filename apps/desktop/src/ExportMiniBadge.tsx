import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import type { ExportState } from "./store/app-store";

/** Persistent floating indicator for an in-flight (or just-finished) timeline
 * export, rendered at the App shell level — visible on every tab, not just
 * the Editor. Shows whenever ExportState exists and either the user isn't on
 * the Editor tab or explicitly collapsed the full progress panel there; see
 * App.tsx's render and app-store.ts's ExportState doc comment. Clicking it
 * jumps back to the Editor tab and re-expands the full panel. */
export function ExportMiniBadge({ exportState, onExpand }: { exportState: ExportState; onExpand: () => void }) {
  const { percent, stage, cancelling, result } = exportState;
  const clamped = Math.max(0, Math.min(100, percent));
  const label =
    result?.kind === "success" ? "Export complete" :
    result?.kind === "failure" ? "Export failed" :
    cancelling ? "Cancelling…" : stage;

  return (
    <button type="button" className="export-mini-badge" onClick={onExpand} title="Click to view export progress">
      {result?.kind === "success" ? (
        <CheckCircle2 size={16} className="export-mini-badge-success" />
      ) : result?.kind === "failure" ? (
        <AlertTriangle size={16} className="export-mini-badge-failure" />
      ) : (
        <LoaderCircle size={16} className="spin" />
      )}
      <span className="export-mini-badge-text">{label}</span>
      {!result && !cancelling && <b>{clamped}%</b>}
      {!result && (
        <span className="export-mini-badge-bar"><i style={{ width: `${clamped}%` }} /></span>
      )}
    </button>
  );
}

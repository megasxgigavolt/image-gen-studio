import { Clapperboard, Clock, Redo2, Trash2, Undo2, Upload } from "lucide-react";
import { formatTime } from "../domain/timecode";
import type { ImageRenderRecord, TimelineClipRecord, VideoAssetRecord } from "../infrastructure/projects-client";
import { MotionSettingsPanel } from "./MotionSettingsPanel";

/** Right-panel inspector for the selected still/animation clip: duration,
 * version swaps, the animate-this-clip flow (generate/upload/restore/undo),
 * and the Motion section — Auto Motion composes the first pass automatically
 * (see SOPs/Motion_Graphics_SOP_v1.md), and `MotionSettingsPanel` (below)
 * exposes it as editable per-still dropdowns + a shared intensity slider so
 * it can be reconfigured afterward without re-running the AI. Camera
 * movement transitions and color filter are handled elsewhere (Filters
 * tool, transition picker) and aren't duplicated here. Shown whenever a
 * stills clip is selected and no tool (captions/music/text/filters/logo) is
 * active. */
export function ClipInspector({
  selectedClip,
  selectedClipRenders,
  durationDraft,
  onDurationDraftChange,
  onCommitDuration,
  selectedClipVideoAsset,
  onUploadAnimation,
  uploadingAnimation,
  onUndoAnimation,
  onRestoreAnimation,
  onAdjustAnimationToDuration,
  retiming,
  onSwapRender,
  onResetEffects,
  onMotionRecipeChange,
}: {
  selectedClip: TimelineClipRecord;
  selectedClipRenders: ImageRenderRecord[];
  durationDraft: string | null;
  onDurationDraftChange: (value: string) => void;
  onCommitDuration: () => void;
  selectedClipVideoAsset: VideoAssetRecord | null;
  onUploadAnimation: () => void;
  uploadingAnimation: boolean;
  onUndoAnimation: () => void;
  onRestoreAnimation: () => void;
  onAdjustAnimationToDuration: () => void;
  retiming: boolean;
  onSwapRender: (renderId: string) => void;
  onResetEffects: () => void;
  onMotionRecipeChange: (effect: string | null, settingsJson: string | null, reason: string | null) => void;
}) {
  const durationMismatch = selectedClip.clipKind === "animation" && selectedClipVideoAsset
    ? Math.abs(selectedClipVideoAsset.actualDurationSeconds - (selectedClip.endSeconds - selectedClip.startSeconds)) > 0.05
    : false;
  const provenanceLabel = selectedClipVideoAsset
    ? { generation: "Generated with Veo", retimed: "Generated with Veo (retimed)", upload: "Uploaded clip" }[selectedClipVideoAsset.kind]
    : null;

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-header">
        <strong>{selectedClip.clipKind === "animation" ? "Animated" : "Still"}</strong>
        <span>{formatTime(selectedClip.startSeconds)} – {formatTime(selectedClip.endSeconds)}</span>
        <label className="tl-duration-input-row" title="Clip duration">
          <input
            type="number" className="tl-slider-number" min={0.1} step={0.1}
            value={durationDraft ?? (selectedClip.endSeconds - selectedClip.startSeconds).toFixed(2)}
            onChange={(event) => onDurationDraftChange(event.target.value)}
            onBlur={onCommitDuration}
            onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); }}
          />
          <span>s</span>
        </label>
        {selectedClip.clipKind === "animation" && selectedClipVideoAsset && (
          <span className={durationMismatch ? "tl-duration-pill mismatch" : "tl-duration-pill fit"} title={`Generated ${selectedClipVideoAsset.actualDurationSeconds.toFixed(1)}s vs. this ${(selectedClip.endSeconds - selectedClip.startSeconds).toFixed(1)}s slot`}>
            {durationMismatch ? "Duration mismatch" : "Fits slot"}
          </span>
        )}
      </div>
      {selectedClipRenders.length > 1 && (
        <div className="tl-inspector-group">
          <span className="tl-inspector-label">Version</span>
          <div className="tl-version-chips">
            {selectedClipRenders.map((render) => (
              <button
                key={render.id}
                className={render.id === selectedClip.renderId ? "tl-version-chip active" : "tl-version-chip"}
                onClick={() => onSwapRender(render.id)}
              >
                V{render.version}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="tl-inspector-group">
        <span className="tl-inspector-label"><Clapperboard size={12} />Animation</span>
        {provenanceLabel && <p className="tl-source-hint tl-provenance-label">{provenanceLabel}</p>}

        {selectedClip.clipKind === "still" && !selectedClip.videoAssetId && (
          <>
            <p className="tl-source-hint">
              Generate motion for this still from the <strong>Animate</strong> pipeline stage before placing it here,
              or upload your own clip to use instead.
            </p>
            <button className="tl-upload-secondary" disabled={uploadingAnimation} onClick={onUploadAnimation}>
              <Upload size={12} />{uploadingAnimation ? "Uploading…" : "Or upload your own clip instead"}
            </button>
          </>
        )}

        {selectedClip.clipKind === "animation" && (
          <>
            <p className="tl-source-hint tl-prompt-readout">
              {selectedClipVideoAsset?.prompt ? selectedClipVideoAsset.prompt : "(no prompt — Veo decided the motion on its own)"}
            </p>
            {durationMismatch && selectedClipVideoAsset ? (
              <>
                <p className="tl-source-hint">
                  Doesn't match its slot ({selectedClipVideoAsset.actualDurationSeconds.toFixed(1)}s vs{" "}
                  {(selectedClip.endSeconds - selectedClip.startSeconds).toFixed(1)}s).
                </p>
                <button className="secondary" disabled={retiming} onClick={onAdjustAnimationToDuration}>
                  <Clock size={14} />{retiming ? "Adjusting…" : "Adjust animation to duration"}
                </button>
              </>
            ) : (
              <p className="tl-source-hint">Matches its timeline slot.</p>
            )}
            <button className="secondary" title="Revert to the still — the animation stays cached until a new one is generated or uploaded" onClick={onUndoAnimation}>
              <Undo2 size={14} />Undo animation
            </button>
            <p className="tl-source-hint">
              Reverts to the still. The generated animation stays cached — restore it any time, unless
              you generate or upload a new one first.
            </p>
          </>
        )}

        {selectedClip.clipKind === "still" && selectedClip.videoAssetId && (
          <>
            <button className="secondary" title="Bring back the animation that was previously generated or uploaded for this still" onClick={onRestoreAnimation}>
              <Redo2 size={14} />Restore cached animation
            </button>
            <p className="tl-source-hint">A previously generated animation for this still is cached and ready to bring back.</p>
          </>
        )}
      </div>
      <MotionSettingsPanel selectedClip={selectedClip} onChange={onMotionRecipeChange} />
      <div className="tl-inspector-actions">
        <button className="secondary" onClick={onResetEffects}><Trash2 size={14} />Remove effects (this clip only)</button>
      </div>
    </div>
  );
}

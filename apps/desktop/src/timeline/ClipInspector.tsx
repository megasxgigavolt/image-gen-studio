import { Clapperboard, Clock, Film, Move, Redo2, Scissors, Shuffle, Sparkles, Trash2, Undo2, Upload } from "lucide-react";
import { formatTime } from "../domain/timecode";
import type {
  ColorFilterPreset,
  ImageRenderRecord,
  MotionGraphicEffect,
  TimelineClipRecord,
  TransitionPreset,
  VideoAssetRecord,
} from "../infrastructure/projects-client";
import { MOTION_OPTIONS, TRANSITION_IN_OPTIONS, TRANSITION_OPTIONS } from "./timeline-rendering";
import { getMotionGraphicEffectDef, MOTION_GRAPHIC_EFFECTS, parseMotionGraphicSettings } from "./motion-graphics";

const COLOR_FILTER_PRESETS: ColorFilterPreset[] = ["none", "warm", "cool", "cinematic", "bright", "muted", "dark"];

/** Right-panel inspector for the selected still/animation clip: duration,
 * version swaps, the animate-this-clip flow (generate/upload/restore/undo),
 * camera movement, transitions, and color filter. Shown whenever a stills
 * clip is selected and no tool (captions/music/text/filters/logo) is active. */
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
  onSetMotion,
  onApplyMotionToAll,
  globalIntensity,
  onGlobalIntensityChange,
  onApplyGlobalIntensity,
  onAlternateZoom,
  onSetTransitionIn,
  onApplyTransitionInToAll,
  onSetTransitionOut,
  onApplyTransitionOutToAll,
  onApplyFadeTransitionToAll,
  onRemoveTransitionFromAll,
  onSetColorFilter,
  onApplyColorFilterToAll,
  onSetMotionGraphicEffect,
  onSetMotionGraphicSetting,
  motionGraphicDescription,
  loadingMotionGraphicDescription,
  onResetEffects,
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
  onSetMotion: (preset: TimelineClipRecord["motionPreset"]) => void;
  onApplyMotionToAll: () => void;
  globalIntensity: number;
  onGlobalIntensityChange: (value: number) => void;
  onApplyGlobalIntensity: () => void;
  onAlternateZoom: () => void;
  onSetTransitionIn: (preset: TransitionPreset) => void;
  onApplyTransitionInToAll: () => void;
  onSetTransitionOut: (preset: TransitionPreset) => void;
  onApplyTransitionOutToAll: () => void;
  onApplyFadeTransitionToAll: () => void;
  onRemoveTransitionFromAll: () => void;
  onSetColorFilter: (preset: ColorFilterPreset, intensity: number) => void;
  onApplyColorFilterToAll: () => void;
  onSetMotionGraphicEffect: (effect: MotionGraphicEffect) => void;
  onSetMotionGraphicSetting: (key: string, value: number | string) => void;
  motionGraphicDescription: string | null;
  loadingMotionGraphicDescription: boolean;
  onResetEffects: () => void;
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
      {selectedClip.clipKind !== "animation" && (() => {
        const cameraActive = selectedClip.motionPreset !== "none";
        const motionGraphicActive = Boolean(selectedClip.motionGraphicEffect);
        const cameraInactive = motionGraphicActive;
        const motionGraphicInactive = cameraActive;
        return (
      <>
      <div className={cameraInactive ? "tl-inspector-group tl-inspector-group-dimmed" : "tl-inspector-group"}>
          <div className="tl-inspector-label-row">
            <span className="tl-inspector-label"><Move size={12} />Camera movement</span>
            {cameraInactive ? <span className="tl-inactive-pill">Inactive — Motion Graphics is applied</span> : <button className="tl-apply-all-btn" onClick={onApplyMotionToAll}>Apply to all</button>}
          </div>
          <div className="tl-preset-grid two">
            {MOTION_OPTIONS.map((option) => (
              <button
                key={option.value}
                className={selectedClip.motionPreset === option.value ? "tl-preset-btn active" : "tl-preset-btn"}
                onClick={() => onSetMotion(option.value)}
                title={option.label}
              >
                <option.icon size={13} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
          <div className="tl-inspector-label-row" style={{ marginTop: "10px" }}>
            <span className="tl-inspector-label">Movement intensity</span>
            <button className="tl-apply-all-btn" onClick={onApplyGlobalIntensity}>Apply to all</button>
          </div>
          <div className="tl-intensity-control">
            <input
              type="range" className="tl-slider" min={0.05} max={0.5} step={0.01}
              value={globalIntensity}
              onChange={(event) => onGlobalIntensityChange(Number(event.target.value))}
              onPointerUp={onApplyGlobalIntensity}
            />
            <span className="tl-intensity-value">{Math.round(globalIntensity * 100)}%</span>
          </div>
          <button className="secondary full" style={{ marginTop: "6px" }} onClick={onAlternateZoom}><Shuffle size={14} />Alternate zoom in/out (all stills)</button>
      </div>
      <div className={motionGraphicInactive ? "tl-inspector-group tl-inspector-group-dimmed" : "tl-inspector-group"}>
          <div className="tl-inspector-label-row">
            <span className="tl-inspector-label"><Film size={12} />Motion Graphics</span>
            {motionGraphicInactive && <span className="tl-inactive-pill">Inactive — Camera movement is applied</span>}
          </div>
          {!selectedClip.motionGraphicEffect && (
            <p className="tl-source-hint">
              OpenAI inspects every still on the timeline together with its narration against 7 documented
              camera-movement treatments — Ken Burns, Sequential Panel Reveal, Speed Pan &amp; Motion Blur,
              Ominous Push-In, Candlelight Flicker, Focus Pull, and Iris Reveal — and picks the best fit for each,
              balancing the mix across the whole video. Run Auto motion from the toolbar above to assign every
              still at once, or pick a treatment for just this still below. The assigned treatment renders for
              real at export time (glow, desaturation, blur, and flicker included); Camera Movement above only
              shows a rough approximation for the live preview.
            </p>
          )}
          {selectedClip.motionGraphicEffect && loadingMotionGraphicDescription && (
                <div className="tl-skeleton-line" aria-hidden="true" />
              )}
          {selectedClip.motionGraphicEffect && !loadingMotionGraphicDescription && motionGraphicDescription && (
                <p className="tl-source-hint tl-prompt-readout">{motionGraphicDescription}</p>
              )}
              <div className="tl-preset-grid two">
                {MOTION_GRAPHIC_EFFECTS.map((def) => (
                  <button
                    key={def.id}
                    className={selectedClip.motionGraphicEffect === def.id ? "tl-preset-btn active" : "tl-preset-btn"}
                    onClick={() => onSetMotionGraphicEffect(def.id)}
                    title={def.summary}
                  >
                    <span>{def.label}</span>
                  </button>
                ))}
              </div>
          {selectedClip.motionGraphicEffect && (() => {
                const def = getMotionGraphicEffectDef(selectedClip.motionGraphicEffect);
                if (!def) return null;
                const settings = parseMotionGraphicSettings(selectedClip.motionGraphicSettings);
                return (
                  <>
                    {def.fields.map((field) => (
                      <div key={field.key} className="tl-inspector-label-row" style={{ marginTop: "8px" }}>
                        <span className="tl-inspector-label">{field.label}</span>
                        {field.type === "range" ? (
                          <div className="tl-intensity-control">
                            <input
                              type="range" className="tl-slider"
                              min={field.min} max={field.max} step={field.step}
                              value={Number(settings[field.key] ?? field.min)}
                              onChange={(event) => onSetMotionGraphicSetting(field.key, Number(event.target.value))}
                            />
                            <span className="tl-intensity-value">{settings[field.key] ?? field.min}</span>
                          </div>
                        ) : (
                          <select
                            value={String(settings[field.key] ?? field.options[0])}
                            onChange={(event) => onSetMotionGraphicSetting(field.key, event.target.value)}
                          >
                            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        )}
                      </div>
                    ))}
                    <p className="tl-source-hint" style={{ marginTop: "8px" }}>{def.bestFor}</p>
                  </>
                );
              })()}
      </div>
      </>
        );
      })()}
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label"><Sparkles size={12} />Transition in</span>
          <button className="tl-apply-all-btn" onClick={onApplyTransitionInToAll}>Apply to all</button>
        </div>
        <div className="tl-preset-grid three">
          {TRANSITION_IN_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={selectedClip.transitionIn === value ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => onSetTransitionIn(value)}
              title={label}
            >
              <Icon size={13} /><span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label"><Sparkles size={12} />Transition out</span>
          <button className="tl-apply-all-btn" onClick={onApplyTransitionOutToAll}>Apply to all</button>
        </div>
        <div className="tl-preset-grid transition-out-grid">
          {TRANSITION_OPTIONS.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              className={selectedClip.transitionOut === value ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => onSetTransitionOut(value)}
              title={label}
            >
              <Icon size={13} /><span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Transitions (all stills)</span>
        <div className="tl-preset-grid two">
          <button className="secondary" onClick={onApplyFadeTransitionToAll}><Sparkles size={14} />Fade all</button>
          <button className="secondary" onClick={onRemoveTransitionFromAll}><Scissors size={14} />Cut all</button>
        </div>
      </div>
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label">Color filter</span>
          <button className="tl-apply-all-btn" onClick={onApplyColorFilterToAll}>Apply to all</button>
        </div>
        <div className="tl-preset-grid two">
          {COLOR_FILTER_PRESETS.map((preset) => (
            <button
              key={preset}
              className={selectedClip.colorFilterPreset === preset ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => onSetColorFilter(preset, selectedClip.colorFilterIntensity)}
            >
              <span style={{ textTransform: "capitalize" }}>{preset}</span>
            </button>
          ))}
        </div>
        {selectedClip.colorFilterPreset !== "none" && (
          <div className="tl-intensity-control">
            <input
              type="range" className="tl-slider" min={0} max={100} step={1}
              value={selectedClip.colorFilterIntensity}
              onChange={(event) => onSetColorFilter(selectedClip.colorFilterPreset, Number(event.target.value))}
            />
            <span className="tl-intensity-value">{Math.round(selectedClip.colorFilterIntensity)}%</span>
          </div>
        )}
      </div>
      <div className="tl-inspector-actions">
        <button className="secondary" onClick={onResetEffects}><Trash2 size={14} />Remove effects (this clip only)</button>
      </div>
    </div>
  );
}

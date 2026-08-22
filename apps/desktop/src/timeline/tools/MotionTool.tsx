import { useEffect, useRef, useState } from "react";
import { Shuffle, Wand2, Zap } from "lucide-react";
import { parseMotionRecipe, projectsClient, type CameraEffect, type TimelineRecord, type TransitionPreset } from "../../infrastructure/projects-client";
import { applyCameraEffect } from "../motionRecipeIntensity";
import { TRANSITION_OPTIONS } from "../timeline-rendering";

type ZoomMode = "zoom_in" | "zoom_out" | "alternate";

const ZOOM_MODE_OPTIONS: { value: ZoomMode; label: string }[] = [
  { value: "zoom_in", label: "Zoom in" },
  { value: "zoom_out", label: "Zoom out" },
  { value: "alternate", label: "Alternate zoom in/out" },
];

// Debounce for both live-apply effects below: long enough that dragging a
// slider doesn't fire a bulk write on every pixel of motion, short enough
// that the canvas preview still reads as "live" once the user pauses.
const LIVE_APPLY_DEBOUNCE_MS = 220;

/** State 4 tool panel for the Motion toolbar icon — two independent global
 * bulk-apply sections (zoom, transition), each gated by its own toggle
 * rather than an explicit "Apply" button: once its toggle is on, changing
 * the mode dropdown or the strength slider re-applies to every clip on the
 * Stills lane automatically (debounced), so the canvas preview keeps up
 * with the slider in near-real-time. Zoom writes go through the same
 * per-clip `motion_graphic_settings_json` loop the per-still Camera Effect
 * dropdown (MotionSettingsPanel) reads (mirroring MusicTool's "apply to
 * all clips" pattern — no dedicated backend bulk command for this one,
 * since the target field is a freely-composed recipe, not a plain column).
 * Transition writes use the existing `apply_transition_out_to_all_clips`/
 * `apply_transition_intensity_to_all_clips` bulk commands directly, since
 * those target plain DB columns. Either section stays independently
 * editable per clip afterward via MotionSettingsPanel. */
export function MotionTool({
  videoId,
  timeline,
  refresh,
  addToast,
}: {
  videoId: string;
  timeline: TimelineRecord;
  refresh: (promise: Promise<TimelineRecord>) => Promise<void>;
  addToast: (message: string, kind?: "success" | "error" | "info") => void;
}) {
  const [zoomEnabled, setZoomEnabled] = useState(false);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("alternate");
  const [zoomIntensity, setZoomIntensity] = useState(60);
  const [applyingZoom, setApplyingZoom] = useState(false);
  const zoomApplyingRef = useRef(false);

  const [transitionEnabled, setTransitionEnabled] = useState(false);
  const [transitionType, setTransitionType] = useState<TransitionPreset>("cross-fade");
  const [transitionIntensity, setTransitionIntensity] = useState(50);
  const [applyingTransition, setApplyingTransition] = useState(false);

  // Every clip on the Stills lane, regardless of clipKind — a still
  // replaced by an animation (Veo) or imported video clip keeps whatever
  // Camera Effect was set on it (the live preview and real export both
  // apply it now, see useTimelinePlayback.ts/video_export_engine.py), so
  // excluding those kinds here would silently skip clips this bulk action
  // is meant to reach just as much as plain stills.
  const stills = [...timeline.clips]
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const averageDuration = stills.length
    ? stills.reduce((sum, clip) => sum + Math.max(0.1, clip.endSeconds - clip.startSeconds), 0) / stills.length
    : 3;

  async function applyGlobalZoom() {
    if (!stills.length || zoomApplyingRef.current) return;
    zoomApplyingRef.current = true;
    setApplyingZoom(true);
    try {
      for (const [index, clip] of stills.entries()) {
        const effect: CameraEffect = zoomMode === "alternate"
          ? (index % 2 === 0 ? "zoom_in" : "zoom_out")
          : zoomMode;
        // A recipe's scale delta is a fixed TOTAL change, interpolated
        // across each clip's own duration (see applyMotionRecipe) — the
        // same intensity% on a 10s still and a 2s still therefore produces
        // very different perceived zoom SPEEDS (slow vs. abrupt) unless
        // scaled by duration here. Normalized against the timeline's own
        // average still length so the slider's value reads as one
        // consistent pace across every still, not a fixed total amount.
        const duration = Math.max(0.1, clip.endSeconds - clip.startSeconds);
        const scaledIntensity = Math.min(150, Math.max(5, Math.round(zoomIntensity * (duration / averageDuration))));
        const recipe = applyCameraEffect(parseMotionRecipe(clip.motionGraphicSettingsJson), effect, scaledIntensity);
        const label = effect === "zoom_in" ? "Zoom In" : "Zoom Out";
        await projectsClient.setTimelineClipMotionGraphic(
          videoId, clip.id, `${zoomMode === "alternate" ? "Alternating" : "Global"}: ${label}`,
          JSON.stringify(recipe), null,
        );
      }
      await refresh(projectsClient.getTimeline(videoId));
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      zoomApplyingRef.current = false;
      setApplyingZoom(false);
    }
  }

  async function applyGlobalTransition() {
    setApplyingTransition(true);
    try {
      await refresh(projectsClient.applyTransitionOutToAllClips(videoId, transitionType));
      if (transitionType !== "cut") {
        await refresh(projectsClient.applyTransitionIntensityToAllClips(videoId, transitionIntensity));
      }
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      setApplyingTransition(false);
    }
  }

  // Live-apply: once its toggle is on, every change to the mode/intensity
  // below re-applies to all clips after a short pause, no button needed —
  // turning the toggle off just stops further auto-apply, it doesn't
  // revert clips already touched.
  useEffect(() => {
    if (!zoomEnabled) return;
    const handle = setTimeout(() => { void applyGlobalZoom(); }, LIVE_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomEnabled, zoomMode, zoomIntensity]);

  useEffect(() => {
    if (!transitionEnabled) return;
    const handle = setTimeout(() => { void applyGlobalTransition(); }, LIVE_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transitionEnabled, transitionType, transitionIntensity]);

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <div className="pref-toggle-row">
          <span className="tl-inspector-label"><Zap size={12} />Global zoom</span>
          <label className="pref-switch">
            <input
              type="checkbox" checked={zoomEnabled}
              onChange={(event) => setZoomEnabled(event.target.checked)}
              aria-label="Enable global zoom"
            />
            <span className="pref-switch-track" />
          </label>
        </div>
        <p className="tl-source-hint">
          While on, every change below is applied live to every still — scaled per still so the
          zoom reads at the same pace regardless of how long each still is on screen. Each still's
          own Camera Effect dropdown stays independently editable afterward.
        </p>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Zoom mode</span>
        <select
          className="tl-select"
          value={zoomMode}
          onChange={(event) => setZoomMode(event.target.value as ZoomMode)}
        >
          {ZOOM_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Zoom amount</span>
        <div className="tl-intensity-control">
          <input
            type="range" className="tl-slider" min={0} max={150} step={1}
            value={zoomIntensity}
            onChange={(event) => setZoomIntensity(Number(event.target.value))}
          />
          <span className="tl-intensity-value">{zoomIntensity}%</span>
        </div>
        {applyingZoom && <p className="tl-source-hint"><Wand2 size={11} style={{ verticalAlign: "-1px", marginRight: "4px" }} />Applying…</p>}
      </div>

      <div className="tl-inspector-group">
        <div className="pref-toggle-row">
          <span className="tl-inspector-label"><Shuffle size={12} />Global transition</span>
          <label className="pref-switch">
            <input
              type="checkbox" checked={transitionEnabled}
              onChange={(event) => setTransitionEnabled(event.target.checked)}
              aria-label="Enable global transition"
            />
            <span className="pref-switch-track" />
          </label>
        </div>
        <p className="tl-source-hint">
          While on, every change below is applied live to how every still hands off to the one
          right after it. Each still's own Transition picker stays independently editable afterward.
        </p>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Transition type</span>
        <select
          className="tl-select"
          value={transitionType}
          onChange={(event) => setTransitionType(event.target.value as TransitionPreset)}
        >
          {TRANSITION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {transitionType !== "cut" && (
        <div className="tl-inspector-group">
          <span className="tl-inspector-label">Transition strength</span>
          <div className="tl-intensity-control">
            <input
              type="range" className="tl-slider" min={0} max={100} step={1}
              value={transitionIntensity}
              onChange={(event) => setTransitionIntensity(Number(event.target.value))}
            />
            <span className="tl-intensity-value">{transitionIntensity}%</span>
          </div>
          {applyingTransition && <p className="tl-source-hint"><Wand2 size={11} style={{ verticalAlign: "-1px", marginRight: "4px" }} />Applying…</p>}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { ZoomIn } from "lucide-react";
import { parseMotionRecipe, projectsClient, type TimelineRecord } from "../../infrastructure/projects-client";
import { applyCameraEffect } from "../motionRecipeIntensity";

/** State 4 tool panel for the Motion toolbar icon — a global bulk-apply
 * action that alternates zoom-in/zoom-out across every still on the stills
 * track, in start-time order, at one shared intensity. Modeled directly on
 * MusicTool's "apply to all clips" pattern (a plain frontend loop over the
 * per-clip update command, not a dedicated backend bulk command) so the
 * result writes the exact same `motion_graphic_effect`/
 * `motion_graphic_settings_json` fields the per-still Camera Effect
 * dropdown (MotionSettingsPanel) reads — applying here shows up there too,
 * still independently editable per still afterward. */
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
  const [intensity, setIntensity] = useState(60);
  const [applying, setApplying] = useState(false);

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

  async function applyAlternatingZoom() {
    if (!stills.length || applying) return;
    setApplying(true);
    try {
      for (const [index, clip] of stills.entries()) {
        const effect = index % 2 === 0 ? "zoom_in" : "zoom_out";
        // A recipe's scale delta is a fixed TOTAL change, interpolated
        // across each clip's own duration (see applyMotionRecipe) — the
        // same intensity% on a 10s still and a 2s still therefore produces
        // very different perceived zoom SPEEDS (slow vs. abrupt) unless
        // scaled by duration here. Normalized against the timeline's own
        // average still length so the slider's value reads as one
        // consistent pace across every still, not a fixed total amount.
        const duration = Math.max(0.1, clip.endSeconds - clip.startSeconds);
        const scaledIntensity = Math.min(150, Math.max(5, Math.round(intensity * (duration / averageDuration))));
        const recipe = applyCameraEffect(parseMotionRecipe(clip.motionGraphicSettingsJson), effect, scaledIntensity);
        await projectsClient.setTimelineClipMotionGraphic(
          videoId, clip.id, `Alternating: ${effect === "zoom_in" ? "Zoom In" : "Zoom Out"}`,
          JSON.stringify(recipe), null,
        );
      }
      await refresh(projectsClient.getTimeline(videoId));
      addToast(`Applied alternating zoom to ${stills.length} still${stills.length === 1 ? "" : "s"}.`, "success");
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <span className="tl-inspector-label"><ZoomIn size={12} />Alternate zoom</span>
        <p className="tl-source-hint">
          Assigns zoom-in and zoom-out to every still on the timeline, alternating in order, at the
          amount below — scaled per still so the zoom reads at the same pace regardless of how long
          each still is on screen. Each still's own Camera Effect dropdown stays independently editable
          afterward.
        </p>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Zoom amount</span>
        <div className="tl-intensity-control">
          <input
            type="range" className="tl-slider" min={0} max={150} step={1}
            value={intensity}
            onChange={(event) => setIntensity(Number(event.target.value))}
          />
          <span className="tl-intensity-value">{intensity}%</span>
        </div>
      </div>
      <div className="tl-inspector-group">
        <button
          type="button"
          className="secondary full"
          disabled={!stills.length || applying}
          onClick={() => void applyAlternatingZoom()}
        >
          {applying ? "Applying…" : "Apply alternating zoom to all stills"}
        </button>
      </div>
    </div>
  );
}

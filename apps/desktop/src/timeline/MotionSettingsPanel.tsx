import { RotateCcw, Wand2 } from "lucide-react";
import {
  DEFAULT_MOTION_RECIPE,
  parseMotionRecipe,
  type CameraEffect,
  type DepthEffect,
  type EnvironmentEffect,
  type MotionRecipe,
  type StoryEffect,
  type TimelineClipRecord,
} from "../infrastructure/projects-client";
import {
  applyCameraEffect,
  applyDepthEffect,
  applyEnvironmentEffect,
  applyIntensity,
  applyStoryEffect,
  deriveIntensityFromRecipe,
} from "./motionRecipeIntensity";

const CAMERA_OPTIONS: CameraEffect[] = [
  "position_pan", "zoom_in", "zoom_out", "push_in", "pull_out", "camera_drift", "dynamic_reframing",
];
const DEPTH_OPTIONS: DepthEffect[] = ["none", "parallax_3d", "subject_separation", "depth_blur", "focus_shift", "motion_tracking"];
const STORY_OPTIONS: StoryEffect[] = ["none", "speed_ramp", "freeze_frame", "mask_reveal", "track_matte", "path_animation"];
const ENVIRONMENT_OPTIONS: EnvironmentEffect[] = [
  "none", "dust", "smoke", "fog", "rain", "snow", "fire_embers", "floating_particles", "light_rays",
];

function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function intensityLabel(effect: CameraEffect): string {
  switch (effect) {
    case "zoom_in":
    case "zoom_out":
      return "Zoom amount";
    case "push_in":
    case "pull_out":
      return "Push/pull amount";
    case "position_pan":
      return "Pan amount";
    case "camera_drift":
      return "Drift amount";
    case "dynamic_reframing":
      return "Reframe amount";
    default:
      return "Intensity";
  }
}

/** Local, unexported — no other consumer needs a generic labeled-dropdown
 * row today (unlike App.tsx's SettingSelect, a different, global-per-video
 * feature with its own styling this shouldn't borrow from). */
function TlSelectRow<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="tl-inspector-group">
      <span className="tl-inspector-label">{label}</span>
      <select className="tl-select" value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option} value={option}>{humanize(option)}</option>
        ))}
      </select>
    </div>
  );
}

/** Interactive per-still motion settings — replaces ClipInspector's old
 * read-only Motion readout. Four dropdowns for the categorical MotionRecipe
 * tiers (camera/depth/story/environment — transitionOut is deliberately
 * excluded, it already has its own separate mechanism, see
 * `timeline_clips.transition_out`) plus one shared intensity slider whose
 * meaning follows whichever camera effect is selected. AI-composed by Auto
 * Motion initially, freely reconfigurable per still afterward — a manual
 * edit here never re-runs the AI or its vision-QA pass, it just persists
 * the edited recipe directly (see motion_graphics_engine.py's module
 * docstring for that tradeoff). */
export function MotionSettingsPanel({
  selectedClip,
  onChange,
  onResetToAiDefault,
}: {
  selectedClip: TimelineClipRecord;
  onChange: (effect: string | null, settingsJson: string | null, reason: string | null) => void;
  /** Discards any manual edit, restoring exactly what Auto Motion composed
   * for this clip — only ever rendered when `motionGraphicAiSnapshotJson`
   * is set, i.e. Auto Motion has actually analyzed this clip at least once
   * (a still built from scratch by hand has nothing to reset to). */
  onResetToAiDefault: () => void;
}) {
  if (!selectedClip.motionGraphicEffect) {
    // A snapshot can still be present here even with no live effect — e.g.
    // Auto Motion composed one and "Remove effects" cleared it back to
    // none afterward (that clears the live columns only, deliberately
    // leaving the snapshot for exactly this recovery path).
    return (
      <div className="tl-inspector-group">
        <span className="tl-inspector-label"><Wand2 size={12} />Motion</span>
        <p className="tl-source-hint">No motion generated yet for this still — run Auto motion.</p>
        {selectedClip.motionGraphicAiSnapshotJson && (
          <button
            className="tl-upload-secondary"
            title="Bring back the treatment Auto Motion previously composed for this still"
            onClick={onResetToAiDefault}
          >
            <RotateCcw size={12} />Restore AI-composed motion
          </button>
        )}
        <button
          className="tl-upload-secondary"
          onClick={() => onChange(
            `Manual: ${humanize(DEFAULT_MOTION_RECIPE.cameraEffect)}`,
            JSON.stringify(DEFAULT_MOTION_RECIPE),
            null,
          )}
        >
          <Wand2 size={12} />Or start from scratch
        </button>
      </div>
    );
  }

  const recipe = parseMotionRecipe(selectedClip.motionGraphicSettingsJson);
  const intensity = deriveIntensityFromRecipe(recipe, recipe.cameraEffect);

  function commit(updated: MotionRecipe) {
    // A manual settings edit keeps whatever free-text label/reason Auto
    // Motion already wrote — they're display-only (the canvas preview reads
    // settingsJson directly via applyMotionRecipe, and export always has,
    // via services/motion-engine) — so there's nothing to resynthesize here.
    onChange(selectedClip.motionGraphicEffect, JSON.stringify(updated), selectedClip.motionGraphicReason);
  }

  return (
    <>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label"><Wand2 size={12} />Motion</span>
        {selectedClip.motionGraphicReason && (
          <p className="tl-source-hint tl-prompt-readout">{selectedClip.motionGraphicReason}</p>
        )}
        {selectedClip.motionGraphicAiSnapshotJson && (
          <button
            className="tl-upload-secondary"
            title="Discard any manual changes below and restore what Auto Motion originally composed for this still"
            onClick={onResetToAiDefault}
          >
            <RotateCcw size={12} />Reset to AI default
          </button>
        )}
      </div>
      <TlSelectRow
        label="Camera effect"
        value={recipe.cameraEffect}
        options={CAMERA_OPTIONS}
        onChange={(effect) => commit(applyCameraEffect(recipe, effect, intensity))}
      />
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">{intensityLabel(recipe.cameraEffect)}</span>
        <div className="tl-intensity-control">
          <input
            type="range" className="tl-slider" min={0} max={150} step={1}
            value={intensity}
            onChange={(event) => commit(applyIntensity(recipe, recipe.cameraEffect, Number(event.target.value)))}
          />
          <span className="tl-intensity-value">{intensity}%</span>
        </div>
        <p className="tl-source-hint">Subtle at the low end, more dramatic as it climbs toward 150%.</p>
      </div>
      <TlSelectRow
        label="Depth effect"
        value={recipe.depthEffect}
        options={DEPTH_OPTIONS}
        onChange={(effect) => commit(applyDepthEffect(recipe, effect))}
      />
      <TlSelectRow
        label="Story effect"
        value={recipe.storyEffect}
        options={STORY_OPTIONS}
        onChange={(effect) => commit(applyStoryEffect(recipe, effect))}
      />
      <TlSelectRow
        label="Environment effect"
        value={recipe.environmentEffect}
        options={ENVIRONMENT_OPTIONS}
        onChange={(effect) => commit(applyEnvironmentEffect(recipe, effect))}
      />
    </>
  );
}

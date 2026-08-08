import {
  DEFAULT_MOTION_RECIPE,
  type CameraEffect,
  type DepthEffect,
  type EnvironmentEffect,
  type MotionRecipe,
  type StoryEffect,
} from "../infrastructure/projects-client";

/** Pure mapping logic behind the Motion panel's dropdowns + shared intensity
 * slider (see MotionSettingsPanel.tsx). Kept separate from the React
 * component so it's independently unit-testable — this is the riskiest new
 * logic in the per-still motion editing feature, since it's the only place
 * translating a single 0-150% slider into very different underlying
 * MotionRecipe fields depending on which camera effect is selected. */

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Maps a 0-150 percent onto [min, max] — deliberately NOT clamped to the
 * [min, max] range itself: 100% lands exactly on `max`, and the slider's
 * extended headroom up to 150% intentionally extrapolates past it for the
 * rare case a user wants something stronger than the subtle default ceiling.
 * The caller clamps the input percent to [0, 150] before this runs. */
function fromPercent(percent: number, min: number, max: number): number {
  return min + (max - min) * (percent / 100);
}

/** Inverse of `fromPercent`, for deriving a slider position from whatever a
 * recipe's fields already hold (e.g. an AI-composed recipe on first select).
 * Clamped to [0, 150] for display — a recipe whose delta sits outside the
 * slider's own range (e.g. an AI pick near the backend's wider safety
 * ceiling) just shows as pinned to one end rather than an out-of-range
 * number. */
function toPercent(value: number, min: number, max: number): number {
  if (max === min) return 100;
  return Math.round(clamp(((value - min) / (max - min)) * 100, 0, 150));
}

const SCALE_DELTA_MIN = 0.02;
const SCALE_DELTA_MAX = 0.3;
const PAN_DELTA_MIN = 1;
const PAN_DELTA_MAX = 12;

const SCALE_GROWS: ReadonlySet<CameraEffect> = new Set(["zoom_in", "push_in"]);
const SCALE_DOMINANT: ReadonlySet<CameraEffect> = new Set(["zoom_in", "zoom_out", "push_in", "pull_out"]);
const PAN_DOMINANT: ReadonlySet<CameraEffect> = new Set(["position_pan", "camera_drift"]);

/** Sensible baseline shape per Tier-1 camera effect, seeded from
 * DEFAULT_MOTION_RECIPE — applied whenever the cameraEffect dropdown
 * changes, before the current intensity is reapplied on top. Without this,
 * switching e.g. zoom_in -> position_pan would leave stale zoom scale
 * values in place until the slider was also touched. */
export const CAMERA_EFFECT_BASE_PATCH: Record<CameraEffect, Partial<MotionRecipe>> = {
  zoom_in: { scaleFrom: 1.0, scaleTo: 1.1, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 },
  zoom_out: { scaleFrom: 1.1, scaleTo: 1.0, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0 },
  push_in: { scaleFrom: 1.0, scaleTo: 1.12, panXFrom: 0, panXTo: 1.5, panYFrom: 0, panYTo: 0 },
  pull_out: { scaleFrom: 1.15, scaleTo: 1.0, panXFrom: 1.5, panXTo: 0, panYFrom: 0, panYTo: 0 },
  position_pan: { scaleFrom: 1.03, scaleTo: 1.03, panXFrom: -4, panXTo: 4, panYFrom: 0, panYTo: 0 },
  camera_drift: { scaleFrom: 1.0, scaleTo: 1.04, panXFrom: -2, panXTo: 2, panYFrom: -1, panYTo: 1 },
  dynamic_reframing: { scaleFrom: 1.0, scaleTo: 1.12, panXFrom: -5, panXTo: 5, panYFrom: 0, panYTo: 2 },
};

function applyScaleIntensity(recipe: MotionRecipe, effect: CameraEffect, percent: number): MotionRecipe {
  const delta = fromPercent(percent, SCALE_DELTA_MIN, SCALE_DELTA_MAX);
  return SCALE_GROWS.has(effect)
    ? { ...recipe, scaleFrom: 1.0, scaleTo: 1.0 + delta }
    : { ...recipe, scaleFrom: 1.0 + delta, scaleTo: 1.0 };
}

/** Preserves whichever axis/direction the recipe's pan already implies
 * (defaults to a flat horizontal pan if currently neutral on both axes),
 * sets the magnitude from the slider, centered at 0. */
function applyPanIntensity(recipe: MotionRecipe, percent: number): MotionRecipe {
  const magnitude = fromPercent(percent, PAN_DELTA_MIN, PAN_DELTA_MAX);
  const half = magnitude / 2;
  const currentDx = recipe.panXTo - recipe.panXFrom;
  const currentDy = recipe.panYTo - recipe.panYFrom;
  const useY = Math.abs(currentDy) > Math.abs(currentDx);
  if (useY) {
    const sign = currentDy < 0 ? -1 : 1;
    return { ...recipe, panXFrom: 0, panXTo: 0, panYFrom: -half * sign, panYTo: half * sign };
  }
  const sign = currentDx < 0 ? -1 : 1;
  return { ...recipe, panXFrom: -half * sign, panXTo: half * sign, panYFrom: 0, panYTo: 0 };
}

/** dynamic_reframing carries meaningful scale AND pan together — both are
 * scaled by the same slider percent, preserving the pan's existing
 * direction (as a unit vector) rather than collapsing it onto one axis. */
function applyDynamicReframingIntensity(recipe: MotionRecipe, percent: number): MotionRecipe {
  const withScale = applyScaleIntensity(recipe, "dynamic_reframing", percent);
  const magnitude = fromPercent(percent, PAN_DELTA_MIN, PAN_DELTA_MAX);
  const half = magnitude / 2;
  const currentDx = recipe.panXTo - recipe.panXFrom;
  const currentDy = recipe.panYTo - recipe.panYFrom;
  const currentMagnitude = Math.hypot(currentDx, currentDy);
  const unitX = currentMagnitude > 0.01 ? currentDx / currentMagnitude : 1;
  const unitY = currentMagnitude > 0.01 ? currentDy / currentMagnitude : 0;
  return {
    ...withScale,
    panXFrom: -half * unitX, panXTo: half * unitX,
    panYFrom: -half * unitY, panYTo: half * unitY,
  };
}

/** The shared slider's core mapping (0-150%, 100% = the slider's own
 * "normal" ceiling, matching the subtle end of what Auto Motion composes by
 * default). Always sets absolute magnitude rather than multiplying whatever
 * was already there, so repeated small drags never compound/drift. Scoped
 * to Tier-1 camera-move magnitude only — rotation and Tiers 2/4/5 are left
 * untouched, matching "zoom in should be subtle" rather than trying to be a
 * single dial over the whole recipe. */
export function applyIntensity(recipe: MotionRecipe, cameraEffect: CameraEffect, intensityPercent: number): MotionRecipe {
  const percent = clamp(intensityPercent, 0, 150);
  if (cameraEffect === "dynamic_reframing") return applyDynamicReframingIntensity(recipe, percent);
  if (SCALE_DOMINANT.has(cameraEffect)) return applyScaleIntensity(recipe, cameraEffect, percent);
  if (PAN_DOMINANT.has(cameraEffect)) return applyPanIntensity(recipe, percent);
  return recipe;
}

/** Inverse of `applyIntensity` — derives a sensible slider position from a
 * recipe's current values, so opening the panel for an AI-composed still
 * shows what the AI actually chose rather than a meaningless default. For
 * dynamic_reframing, where both scale and pan are meaningful, scale is
 * authoritative for the displayed percentage (a deliberate, simple
 * tie-break rather than trying to average two independently-scaled dials). */
export function deriveIntensityFromRecipe(recipe: MotionRecipe, cameraEffect: CameraEffect): number {
  if (SCALE_DOMINANT.has(cameraEffect) || cameraEffect === "dynamic_reframing") {
    return toPercent(Math.abs(recipe.scaleTo - recipe.scaleFrom), SCALE_DELTA_MIN, SCALE_DELTA_MAX);
  }
  if (PAN_DOMINANT.has(cameraEffect)) {
    const magnitude = Math.hypot(recipe.panXTo - recipe.panXFrom, recipe.panYTo - recipe.panYFrom);
    return toPercent(magnitude, PAN_DELTA_MIN, PAN_DELTA_MAX);
  }
  return 100;
}

/** Switches cameraEffect: re-seeds Tier-1 fields from the new effect's
 * baseline shape, then reapplies the given intensity on top so the slider
 * position carries over across the switch. */
export function applyCameraEffect(recipe: MotionRecipe, cameraEffect: CameraEffect, intensityPercent: number): MotionRecipe {
  const patched: MotionRecipe = { ...recipe, cameraEffect, ...CAMERA_EFFECT_BASE_PATCH[cameraEffect] };
  return applyIntensity(patched, cameraEffect, intensityPercent);
}

/** Switching a secondary tier to "none" zeroes its fields (mirrors
 * `_clamp_recipe`'s server-side neutralization when a tier isn't selected —
 * see motion_graphics_engine.py); switching from "none" to an active option
 * seeds that tier's fields from DEFAULT_MOTION_RECIPE if they're currently
 * still at neutral, without inventing bespoke tuning per option beyond what
 * the AI's own default already provides. */
export function applyDepthEffect(recipe: MotionRecipe, depthEffect: DepthEffect): MotionRecipe {
  if (depthEffect === "none") {
    return {
      ...recipe, depthEffect,
      fgScaleFrom: 1, fgScaleTo: 1, fgPanXFrom: 0, fgPanXTo: 0, fgPanYFrom: 0, fgPanYTo: 0,
      bgBlurFromPx: 0, bgBlurToPx: 0, blurFromPx: 0, blurToPx: 0,
    };
  }
  const seed = recipe.depthEffect === "none";
  return {
    ...recipe,
    depthEffect,
    fgScaleFrom: seed ? DEFAULT_MOTION_RECIPE.fgScaleFrom : recipe.fgScaleFrom,
    fgScaleTo: seed ? DEFAULT_MOTION_RECIPE.fgScaleTo : recipe.fgScaleTo,
    subjectMaskSoftness: seed ? DEFAULT_MOTION_RECIPE.subjectMaskSoftness : recipe.subjectMaskSoftness,
  };
}

export function applyStoryEffect(recipe: MotionRecipe, storyEffect: StoryEffect): MotionRecipe {
  if (storyEffect === "none") {
    return {
      ...recipe, storyEffect,
      maskShape: "none", maskHoldFrames: 0, freezeHoldFrames: 0, pathPoints: null, speedCurve: "linear_pace",
    };
  }
  const seed = recipe.storyEffect === "none";
  return {
    ...recipe,
    storyEffect,
    maskFromRadius: seed ? DEFAULT_MOTION_RECIPE.maskFromRadius : recipe.maskFromRadius,
    maskToRadius: seed ? DEFAULT_MOTION_RECIPE.maskToRadius : recipe.maskToRadius,
    maskSoftness: seed ? DEFAULT_MOTION_RECIPE.maskSoftness : recipe.maskSoftness,
    freezeAtProgress: seed ? DEFAULT_MOTION_RECIPE.freezeAtProgress : recipe.freezeAtProgress,
  };
}

export function applyEnvironmentEffect(recipe: MotionRecipe, environmentEffect: EnvironmentEffect): MotionRecipe {
  if (environmentEffect === "none") {
    return { ...recipe, environmentEffect, environmentIntensity: 0 };
  }
  const seed = recipe.environmentEffect === "none" || recipe.environmentIntensity <= 0;
  return {
    ...recipe,
    environmentEffect,
    environmentIntensity: seed ? DEFAULT_MOTION_RECIPE.environmentIntensity : recipe.environmentIntensity,
  };
}

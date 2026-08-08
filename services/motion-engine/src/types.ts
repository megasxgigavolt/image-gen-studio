// A "motion recipe" realizes one clip's treatment, chosen by the AI selection
// pass (see services/python-engine/auto_gen_engine/motion_graphics_engine.py)
// from a FIXED catalog of named effects grouped into 5 tiers — there is no
// per-effect hand-coded component; `MotionClip.tsx` is the ONE generic
// renderer that maps each named effect onto a small set of continuous
// numeric dials. This mirrors the Python `MotionRecipe` Pydantic model
// field-for-field via camelCase aliases (kept in sync manually — see that
// module's docstring) — `.model_dump(by_alias=True)` on the Python side hands
// this exact shape straight through as the `recipe` prop below.
export type CameraEffect =
  | "position_pan"
  | "zoom_in"
  | "zoom_out"
  | "push_in"
  | "pull_out"
  | "camera_drift"
  | "dynamic_reframing";

export type DepthEffect = "none" | "parallax_3d" | "subject_separation" | "depth_blur" | "focus_shift" | "motion_tracking";

// Matches apps/desktop/src-tauri/src/projects.rs's VALID_TRANSITIONS strings
// exactly — this engine doesn't render transitions itself (that's ffmpeg's
// xfade, see video_export_engine.py), but the value travels through the same
// `MotionRecipe.transitionOut` field end to end, so it's documented here too.
export type TransitionOut = "cut" | "fade" | "cross-fade" | "whip-pan" | "zoom-blur" | "blur-transition";

export type StoryEffect = "none" | "speed_ramp" | "freeze_frame" | "mask_reveal" | "track_matte" | "path_animation";

export type EnvironmentEffect =
  | "none"
  | "dust"
  | "smoke"
  | "fog"
  | "rain"
  | "snow"
  | "fire_embers"
  | "floating_particles"
  | "light_rays";

export type MotionEasing = "linear" | "ease" | "easeIn" | "easeOut" | "cubic" | "elastic";
export type MaskShape = "none" | "circle" | "linear-h" | "linear-v";
export type SpeedCurve = "linear_pace" | "punch_in_hold" | "slow_fast_slow" | "fast_start_ease_out";

/** One waypoint of a `path_animation` route — same signed percent-of-frame
 * unit as `panXFrom`/`panYFrom`, just more than 2 of them. */
export interface PanPoint {
  x: number;
  y: number;
}

export interface MotionRecipe {
  // --- Tier 1: camera move (always active) ---
  cameraEffect: CameraEffect;
  scaleFrom: number; // 1.0 = no zoom
  scaleTo: number;
  panXFrom: number; // percent of frame width, signed
  panXTo: number;
  panYFrom: number; // percent of frame height, signed
  panYTo: number;
  rotationFromDeg: number;
  rotationToDeg: number;
  originX: number; // percent 0-100 — anchor point for scale/rotation
  originY: number;
  easing: MotionEasing;
  motionBlurStrength: number; // 0 = none; >0 adds directional blur + faint ghost-trail layers peaking mid-move
  shakeAmount: number; // 0 = none; subtle deterministic handheld jitter

  // --- Subject anchor: a fractional bounding box (0-1) around the actual
  // main subject/focal point of the image, always set — informs origin/pan
  // and, when a Tier-2 depth effect is active, which pixels get cut into the
  // foreground layer. ---
  subjectRegionX: number;
  subjectRegionY: number;
  subjectRegionW: number;
  subjectRegionH: number;

  // --- Tier 2: depth & realism — "none" is the common case. When active,
  // the subject (per subjectRegion above) renders as its own layer with an
  // independent scale/pan from the background layer below, approximating
  // parallax/separation without true image segmentation. ---
  depthEffect: DepthEffect;
  fgScaleFrom: number;
  fgScaleTo: number;
  fgPanXFrom: number;
  fgPanXTo: number;
  fgPanYFrom: number;
  fgPanYTo: number;
  bgBlurFromPx: number;
  bgBlurToPx: number;
  subjectMaskSoftness: number; // 0-1 — feather on the foreground cutout edge
  blurFromPx: number; // whole-frame focus pull (focus_shift) — 0 = sharp
  blurToPx: number;

  // --- Tier 3: transition out — how this clip hands off to the next one on
  // the timeline. Not rendered by this component at all (see
  // video_export_engine.py's xfade handling) — carried here only so the one
  // JSON blob round-trips the full recipe end to end. ---
  transitionOut: TransitionOut;
  whipDirection: "left" | "right";

  // --- Tier 4: storytelling — "none" is the common case. ---
  storyEffect: StoryEffect;
  maskShape: MaskShape; // "none" leaves the frame fully visible throughout
  maskFromRadius: number; // fraction of frame diagonal (circle) or 0-1 progress (linear)
  maskToRadius: number;
  maskX: number; // fraction 0-1 — circle center, ignored for linear shapes
  maskY: number;
  maskHoldFrames: number; // frames held before the mask starts animating
  maskSoftness: number; // 0 = hard edge, 1 = fully feathered edge
  freezeAtProgress: number; // 0-1 — where in the move freeze_frame holds
  freezeHoldFrames: number;
  pathPoints: PanPoint[] | null; // path_animation waypoints, when set (min 2)
  speedCurve: SpeedCurve; // speed_ramp pacing

  // --- Tier 5: environment — "none" is the common case. Rendered as a
  // lightweight deterministic particle/overlay system, not a physical sim —
  // see buildEnvironmentOverlay() in MotionClip.tsx. ---
  environmentEffect: EnvironmentEffect;
  environmentIntensity: number; // 0-1

  // --- Color / light ---
  saturationFrom: number; // 1 = normal
  saturationTo: number;
  glowColor: string | null; // css rgba string; null = no glow overlay at all
  glowX: number; // fraction 0-1
  glowY: number;
  glowOpacity: number;
  glowFlicker: number; // 0 = steady glow, >0 = organic flicker amplitude (candle/firelight-style)
  vignette: number; // 0-1 strength

  // --- Envelope ---
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface MotionClipProps {
  imagePath: string;
  recipe: MotionRecipe;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

export const DEFAULT_RECIPE: MotionRecipe = {
  cameraEffect: "push_in",
  scaleFrom: 1.05,
  scaleTo: 1.2,
  panXFrom: 0,
  panXTo: 0,
  panYFrom: 0,
  panYTo: 0,
  rotationFromDeg: 0,
  rotationToDeg: 0,
  originX: 50,
  originY: 50,
  easing: "ease",
  motionBlurStrength: 0,
  shakeAmount: 0,
  subjectRegionX: 0.3,
  subjectRegionY: 0.25,
  subjectRegionW: 0.4,
  subjectRegionH: 0.5,
  depthEffect: "none",
  fgScaleFrom: 1,
  fgScaleTo: 1,
  fgPanXFrom: 0,
  fgPanXTo: 0,
  fgPanYFrom: 0,
  fgPanYTo: 0,
  bgBlurFromPx: 0,
  bgBlurToPx: 0,
  subjectMaskSoftness: 0.35,
  blurFromPx: 0,
  blurToPx: 0,
  transitionOut: "cut",
  whipDirection: "left",
  storyEffect: "none",
  maskShape: "none",
  maskFromRadius: 0,
  maskToRadius: 1,
  maskX: 0.5,
  maskY: 0.5,
  maskHoldFrames: 0,
  maskSoftness: 0.3,
  freezeAtProgress: 0.5,
  freezeHoldFrames: 0,
  pathPoints: null,
  speedCurve: "linear_pace",
  environmentEffect: "none",
  environmentIntensity: 0.35,
  saturationFrom: 1,
  saturationTo: 1,
  glowColor: null,
  glowX: 0.5,
  glowY: 0.5,
  glowOpacity: 0,
  glowFlicker: 0,
  vignette: 0.15,
  fadeInFrames: 14,
  fadeOutFrames: 14,
};

export const DEFAULT_PROPS: MotionClipProps = {
  imagePath: "",
  recipe: DEFAULT_RECIPE,
  durationInFrames: 150,
  fps: 30,
  width: 1920,
  height: 1080,
};

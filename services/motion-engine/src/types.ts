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
  // A constant extra zoom-in, held flat for the whole clip — unlike
  // cameraEffect/scaleFrom/scaleTo above, which are always a MOVE over
  // time, this one never animates. Multiplies on top of whatever the
  // dynamic camera move computes each frame, so the two compose: e.g. a
  // 20% static zoom under a zoom_in that already goes 1.0->1.1 reads as
  // 1.2->1.32 (see MotionClip.tsx). 0 = no static zoom.
  staticZoomPercent: number;

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
  /** `staticFile()`-relative basename of the source media — a still's
   * generated image, or (once that still has been replaced by an
   * animation/imported clip, see video_export_engine.py's build_segments)
   * a video file. Which one it is is `sourceKind` below; the same
   * `--public-dir`/`staticFile()` resolution mechanism works identically
   * for either. */
  mediaPath: string;
  /** "video" renders `mediaPath` as `<OffthreadVideo>`; "image" (the
   * original, still default) as `<Img>`. The Tier 1-5 transform/mask/filter
   * math in MotionClip.tsx is entirely agnostic to this — it only ever
   * applies to an ancestor `<AbsoluteFill>`'s style, never to the media
   * element itself, so nothing else in this file branches on it. */
  sourceKind: "image" | "video";
  recipe: MotionRecipe;
  durationInFrames: number;
  /** How many frames the camera move normalises its 0->1 progress over,
   * when that differs from `durationInFrames` (the number of frames actually
   * rendered). Defaults to `durationInFrames`.
   *
   * Only a join transition's "tail window" sets this. video_export_engine.py
   * renders the outgoing clip virtually extended past its nominal end so the
   * blend has footage to work with (see `expand_join_transitions`); without
   * this the extended render also STRETCHED the camera move over the longer
   * length, so the tail was a different curve from the clip's own segment
   * and the picture jumped at the moment the transition started. Keeping the
   * motion normalised to the clip's real length makes the tail the exact
   * continuation of it — and since the progress interpolation clamps, the
   * extra frames hold at the fully-eased end pose. */
  motionDurationInFrames?: number;
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
  staticZoomPercent: 0,
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
  mediaPath: "",
  sourceKind: "image",
  recipe: DEFAULT_RECIPE,
  durationInFrames: 150,
  fps: 30,
  width: 1920,
  height: 1080,
};

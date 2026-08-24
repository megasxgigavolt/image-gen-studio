import { invoke } from "@tauri-apps/api/core";
import type { AppStage } from "../store/app-store";

export type ChannelRecord = {
  id: string;
  name: string;
  description: string | null;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VideoRecord = {
  id: string;
  channelId: string;
  title: string;
  stage: AppStage;
  progress: number;
  createdAt: string;
  updatedAt: string;
};

export type VideoProgressRecord = {
  videoId: string;
  totalStills: number;
  generatedStills: number;
  previewRenderId: string | null;
};

export type ResumeRecord = {
  channelId: string | null;
  videoId: string | null;
  stage: AppStage;
  updatedAt: string;
};

export type InputAssetRecord = {
  id: string;
  videoId: string;
  kind: "audio" | "reference";
  originalName: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
};

export type VideoInputsRecord = {
  videoId: string;
  scriptText: string;
  pacingSeconds: number;
  pacingPreset: "calm" | "balanced" | "fast" | "custom" | "per-sentence";
  pacingMinSeconds: number;
  pacingMaxSeconds: number;
  audio: InputAssetRecord | null;
  references: InputAssetRecord[];
  updatedAt: string;
  // None (null) when no plan exists yet, or a legacy plan predates this
  // field and never recorded what generated it.
  planMatchesCurrentInputs: boolean | null;
};

export type PlanSentenceRecord = { id: string; ordinal: number; text: string; startSeconds: number; endSeconds: number };
export type PlanGroupRecord = { id: string; ordinal: number; label: string; kind: string; sentenceIds: string[]; settingsLocked: boolean; promptLocked: boolean; sceneId: string | null };
// A larger narrative/visual unit that can span several stills (PlanGroupRecord).
// narrativeRole/coreIdea/emotionalState/visualOpportunities are null/empty for
// scenes derived without AI (per-sentence pacing, or the AI-error fallback
// path) — the UI shows a plain "no detailed scene analysis available" note
// for those instead of treating it as missing data.
export type PlanSceneRecord = {
  id: string; ordinal: number; label: string;
  narrativeRole: string | null; coreIdea: string | null; emotionalState: string | null;
  visualOpportunities: string[]; sentenceIds: string[]; expanded: boolean;
};
export type VisualPlanRecord = { videoId: string; timingSource: string; sentences: PlanSentenceRecord[]; groups: PlanGroupRecord[]; scenes: PlanSceneRecord[]; updatedAt: string };

// The Visual Director / Diversity & Consistency Controller dials — layered
// the same way every other Bulk Generation setting is: null means
// "inherit," a concrete value overrides. Sliders are 0-100 unless noted.
export type BulkVisualDialsRecord = {
  visualInterpretation: number | null;
  visualMetaphor: number | null;
  cinematicIntensity: number | null;
  promptCreativity: number | null;
  mood: string | null;
  /** "ai" (default) or "user" — only meaningful when `mood` is set. */
  moodMode: string | null;
  diversityCamera: number | null;
  diversityComposition: number | null;
  diversityShotType: number | null;
  consistencyCharacter: number | null;
  consistencyLocation: number | null;
  consistencyStyle: number | null;
};
export function emptyBulkVisualDials(): BulkVisualDialsRecord {
  return {
    visualInterpretation: null, visualMetaphor: null, cinematicIntensity: null, promptCreativity: null,
    mood: null, moodMode: null, diversityCamera: null, diversityComposition: null, diversityShotType: null,
    consistencyCharacter: null, consistencyLocation: null, consistencyStyle: null,
  };
}

// Per-scene overrides for Bulk Generation, layered on top of the video's
// global bulk settings. Every field is nullable — null means "inherit the
// global value" for that one field. A scene with no saved overrides at all
// simply has no entry in getBulkSceneSettings' result, rather than a record
// of all-nulls. Character/location identity used to live here too — see
// RosterCharacterRecord/RosterLocationRecord/SceneCastAssignmentRecord.
export type BulkSceneSettingsRecord = {
  sceneId: string;
  styleDirective: string | null;
  creativeInstruction: string | null;
  dials: BulkVisualDialsRecord;
};

// The video-wide counterpart to BulkSceneSettingsRecord — same shape minus
// sceneId, since a scene layers its own version of this on top.
export type BulkGlobalVisualSettingsRecord = {
  dials: BulkVisualDialsRecord;
  // Visualization Type control — a second, independent axis from the AI's
  // own internal visualType (shot/content framing) choice: this one governs
  // overall visual medium/format (Photograph, Illustration, Diagram, ...).
  // visualizationHardRule is off by default, and the checked types below
  // have NO effect at all until it's turned on — there is no "soft
  // preference" in between.
  visualizationTypes: string[];
  visualizationHardRule: boolean;
};
export function emptyBulkGlobalVisualSettings(): BulkGlobalVisualSettingsRecord {
  return { dials: emptyBulkVisualDials(), visualizationTypes: [], visualizationHardRule: false };
}

// One still's Visualization Type override — unlike BulkSceneSettingsRecord,
// only ever exists for a still that actually has one set (see the backend's
// MIGRATION_042 doc comment), so there's no null case here.
export type BulkStillSettingsRecord = {
  groupId: string;
  visualizationType: string;
};

// One named entry in a video's character or location roster — replaces the
// old single global/scene character+location reference model. Characters
// and locations share this exact shape.
export type RosterCharacterRecord = {
  id: string; videoId: string; ordinal: number; name: string;
  referenceAssetId: string | null; description: string | null;
};
export type RosterLocationRecord = {
  id: string; videoId: string; ordinal: number; name: string;
  referenceAssetId: string | null; description: string | null;
};

// Which roster characters/location a scene should draw on. assignedX is
// what generation/planning actually uses; aiSuggestedX is kept alongside
// purely so the UI can tell "AI suggested this, untouched" apart from "the
// user chose this" — compare the two rather than a separate flag.
export type SceneCastAssignmentRecord = {
  sceneId: string;
  aiSuggestedCharacterIds: string[];
  assignedCharacterIds: string[];
  aiSuggestedLocationId: string | null;
  assignedLocationId: string | null;
};

export type StyleAspectRecord = { key: string; label: string; description: string };

export type CaptionWordRecord = { text: string; startSeconds: number; endSeconds: number };
export type CaptionChunkRecord = { index: number; text: string; startSeconds: number; endSeconds: number; words: CaptionWordRecord[] };
export type CaptionSetRecord = {
  videoId: string;
  intervalSeconds: number;
  srtText: string;
  chunks: CaptionChunkRecord[];
  generatedAt: string;
  updatedAt: string;
};

export type PromptVersionRecord = {
  id: string;
  videoId: string;
  groupId: string;
  version: number;
  settingsJson: string;
  systemPrompt: string;
  userPrompt: string;
  createdAt: string;
};

export type ImageRenderRecord = {
  id: string;
  videoId: string;
  groupId: string;
  version: number;
  promptVersionId: string;
  fileName: string;
  relativePath: string;
  parentRenderId: string | null;
  editInstruction: string | null;
  kind: "generation" | "edit";
  isFinal: boolean;
  editStrength: string | null;
  maskPath: string | null;
  maskUsed: boolean;
  createdAt: string;
  subjectX: number | null;
  subjectY: number | null;
};

export type AppSettingRecord = {
  key: string;
  value: string;
};

export type ProviderKeyStatusRecord = {
  provider: string;
  configured: boolean;
};

export type ImageWorkspaceGroupRecord = {
  group: PlanGroupRecord;
  educationalPlan: EducationalVisualPlanRecord | null;
  promptVersions: PromptVersionRecord[];
  imageRenders: ImageRenderRecord[];
};

export type ImageWorkspaceRecord = {
  videoId: string;
  sentences: PlanSentenceRecord[];
  groups: ImageWorkspaceGroupRecord[];
  settings: AppSettingRecord[];
  // The same scenes getVisualPlan returns — carried along so the Images
  // tab's left pane and Bulk Generation panel can section groups by scene
  // (via sectionGroupsByScene) without a second fetch.
  scenes: PlanSceneRecord[];
};
export type EducationalVisualPlanRecord = {
  stillId: string;
  visualPlanRowId: string;
  educationalObjective: string;
  visualIntent: string;
  subjectStrategy: string;
  imageSettings: Partial<Record<string, string>>;
  userPrompt: string;
  planSignature: string;
  visualStrategyMode: VisualStrategyMode;
  plannerVersion: string;
  createdAt: string;
  updatedAt: string;
};
export type VisualStrategyMode = "Auto Educational" | "Storytelling" | "Documentary" | "Scientific" | "Infographic Heavy";
export type WholeVideoEducationalPlanRecord = {
  strategyMode: VisualStrategyMode;
  plannerVersion: string;
  plans: EducationalVisualPlanRecord[];
};
export type StyleExtractionRecord = { styleDirective: string; imageSettings: Partial<Record<string, string>> };

export type BulkPlannedStillRecord = {
  visualPlanRowId: string;
  ordinal: number;
  narrationPreview: string;
  timestampStart: number;
  timestampEnd: number;
  visualType: string;
  imageSettings: Partial<Record<string, string>>;
  userPrompt: string;
  reason: string;
  settingsLocked: boolean;
  promptLocked: boolean;
};
/** Result of planning (and immediately persisting) ONE batch of stills —
 * see `planBulkVisualsBatch`. Advance a local index by `plannedCount` and
 * keep calling until `done`. */
export type BulkPlanBatchResultRecord = {
  plannedCount: number;
  totalStills: number;
  lastOrdinal: number;
  done: boolean;
};
/** Result of one Auto Motion batch call — see `analyzeMotionGraphicsBatch`.
 * Keep calling until `done`; already-analyzed clips are skipped
 * automatically, so a paused/resumed run never redoes work. */
export type MotionGraphicsBatchResultRecord = {
  completed: number;
  total: number;
  done: boolean;
};

export type ImageJobRecord = {
  id: string;
  videoId: string;
  status: "queued" | "running" | "paused" | "stopped" | "completed" | "failed";
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: string;
  updatedAt: string;
  items: { id: string; groupId: string; promptVersionId: string; status: string; attempts: number; lastError: string | null; renderId: string | null }[];
};

/** One still queued via the single-still "Generate Image" button — a
 * separate, independent queue from `ImageJobRecord`/Bulk Generation (see
 * MIGRATION_043's doc comment in projects.rs), so several single-still
 * generations can queue up and run one at a time in the background without
 * blocking navigation to other stills. */
export type SingleStillGenerationRecord = {
  id: string;
  videoId: string;
  groupId: string;
  promptVersionId: string;
  status: "queued" | "running" | "completed" | "failed";
  renderId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One entry in a video's Bulk Generation queue — see `enqueueBulkGenerationRequest`.
 * `snapshot_json` (style directive, creative instruction, base image settings,
 * scope, dials, roster/cast assignments — everything frozen at the moment
 * Generate was clicked) is intentionally not part of the wire shape; only
 * `totalStills` (its length) is exposed. Requests run strictly one at a time
 * per video — `pending` ones wait, `planning`/`generating` is whichever one
 * is currently active, and only a `pending` request can be cancelled or
 * reordered (an active one is controlled via its `imageJobId` and the
 * existing `controlImageJob`, once generation has started). */
export type BulkGenerationRequestRecord = {
  id: string;
  videoId: string;
  status: "pending" | "planning" | "generating" | "completed" | "failed" | "cancelled";
  position: number;
  totalStills: number;
  planIndex: number;
  imageJobId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** What one `advanceBulkGenerationQueue` call did — drives the queue-runner
 * loop (see `runQueueRunner` in App.tsx): keep calling on `"planned"` (more
 * planning left for the active request), stop and let the existing
 * job-status UI take over on `"generationStarted"`/`"generationInProgress"`,
 * or stop entirely on `"idle"`. */
export type BulkQueueAdvanceResultRecord =
  | { kind: "idle" }
  | { kind: "planned"; requestId: string; current: number; total: number }
  | { kind: "generationStarted"; requestId: string; imageJobId: string }
  | { kind: "generationInProgress"; requestId: string; imageJobId: string };

export type ExportResultRecord = { path: string; fileCount: number };
export type MotionPreset =
  | "none"
  | "zoom-in"
  | "zoom-out"
  | "pan-left"
  | "pan-right"
  | "zoom-pulse"
  | "zoom-in-subject"
  | "zoom-out-subject"
  | "ken-burns"
  | "cuts";
export type TransitionPreset =
  | "cut" | "fade" | "dip-to-white"
  | "cross-fade" | "slide-left" | "slide-right" | "zoom-blur" | "whip-pan" | "blur-transition";
export type ExportResolution = "2160p" | "1080p" | "720p";
export type ExportQuality = "high" | "balanced" | "compressed";
export type ExportCaptionsMode = "burned-in" | "srt" | "both";
export type ExportSettingsRecord = {
  resolution: ExportResolution;
  quality: ExportQuality;
  captionsMode: ExportCaptionsMode;
  includeNarration: boolean;
  includeMusic: boolean;
};
export type ExportJobRecord = {
  id: string;
  videoId: string;
  status: "running" | "completed" | "failed";
  destinationPath: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};
export type ClipKind = "still" | "animation" | "imported-still" | "imported-clip";
export type ColorFilterPreset = "none" | "warm" | "cool" | "cinematic" | "bright" | "muted" | "dark";
export type TimelineClipRecord = {
  id: string; groupId: string; renderId: string | null; ordinal: number; startSeconds: number; endSeconds: number; label: string;
  motionPreset: MotionPreset; transitionIn: TransitionPreset; transitionOut: TransitionPreset; motionIntensity: number;
  /** Strength/duration of `transitionOut`'s effect, 0-100 (default 50) — only
   * meaningful when transitionOut isn't 'cut'. See `TimelineClip.transition_intensity`'s
   * doc comment in projects.rs for exactly what it scales. */
  transitionIntensity: number;
  clipKind: ClipKind; videoAssetId: string | null;
  /** Set for clipKind 'imported-still'/'imported-clip' — the media library asset backing this clip. */
  mediaLibraryAssetId: string | null;
  colorFilterPreset: ColorFilterPreset;
  colorFilterIntensity: number;
  /** AI-composed free-text treatment label (e.g. "slow push with a warm pulsing glow"), or null
   * if this clip hasn't been analyzed yet. Display/debugging only — not validated against any
   * list, there's no fixed catalog of treatments anymore. */
  motionGraphicEffect: MotionGraphicEffect | null;
  /** JSON-stringified `MotionRecipe` for motionGraphicEffect — parse with `parseMotionRecipe`.
   * Field name must match the wire key the Rust struct actually serializes
   * (`motion_graphic_settings_json` -> camelCase `motionGraphicSettingsJson`) — a prior
   * `motionGraphicSettings` name here didn't match and silently deserialized to `undefined`. */
  motionGraphicSettingsJson: string | null;
  /** Short AI-written justification for the composed treatment. */
  motionGraphicReason: string | null;
  /** Non-null once Auto Motion has composed a treatment for this clip at
   * least once — a manual edit in MotionSettingsPanel never clears or
   * updates this, so its presence (not `motionGraphicEffect`'s) is what
   * gates showing "Reset to AI default": there's always something to
   * restore to as long as this is set, even after several manual edits or
   * "Remove effects". Content is opaque here — only
   * `resetTimelineClipMotionGraphicToAi` reads it, server-side. */
  motionGraphicAiSnapshotJson: string | null;
};

/** Free text now — see the `motionGraphicEffect` field doc above. Kept as its own named type
 * (rather than inlining `string`) purely so call sites document intent. */
export type MotionGraphicEffect = string;

// ===== Motion recipe (Timeline editor's per-still Motion panel) =====
// Manually mirrors services/motion-engine/src/types.ts's `MotionRecipe` field-for-field
// (camelCase, same as the Rust struct's `#[serde(rename_all = "camelCase")]` on
// `motion_graphic_settings_json`'s deserialized shape). That package isn't a workspace
// dependency of this app — it's a standalone Remotion project invoked as a subprocess by
// the Python export engine — so there's no shared import to reach for instead; the Python
// side (`motion_graphics_engine.py`'s Pydantic `MotionRecipe`) already mirrors it
// independently the same way, and this is a third, equally manual copy.
export type CameraEffect =
  | "position_pan" | "zoom_in" | "zoom_out" | "push_in" | "pull_out" | "camera_drift" | "dynamic_reframing";
export type DepthEffect = "none" | "parallax_3d" | "subject_separation" | "depth_blur" | "focus_shift" | "motion_tracking";
export type StoryEffect = "none" | "speed_ramp" | "freeze_frame" | "mask_reveal" | "track_matte" | "path_animation";
export type EnvironmentEffect =
  | "none" | "dust" | "smoke" | "fog" | "rain" | "snow" | "fire_embers" | "floating_particles" | "light_rays";
export type MotionEasing = "linear" | "ease" | "easeIn" | "easeOut" | "cubic" | "elastic";
export type MaskShape = "none" | "circle" | "linear-h" | "linear-v";
export type SpeedCurve = "linear_pace" | "punch_in_hold" | "slow_fast_slow" | "fast_start_ease_out";

export type PanPoint = { x: number; y: number };

export type MotionRecipe = {
  cameraEffect: CameraEffect;
  scaleFrom: number; scaleTo: number;
  panXFrom: number; panXTo: number; panYFrom: number; panYTo: number;
  rotationFromDeg: number; rotationToDeg: number;
  originX: number; originY: number;
  easing: MotionEasing;
  motionBlurStrength: number; shakeAmount: number;
  /** A constant extra zoom-in held flat for the whole clip — unlike
   * cameraEffect/scaleFrom/scaleTo above, which are always a MOVE over
   * time, this never animates; it multiplies on top of whatever the
   * dynamic camera move computes each frame (see MotionClip.tsx), so the
   * two compose. 0 = no static zoom. */
  staticZoomPercent: number;
  subjectRegionX: number; subjectRegionY: number; subjectRegionW: number; subjectRegionH: number;
  depthEffect: DepthEffect;
  fgScaleFrom: number; fgScaleTo: number;
  fgPanXFrom: number; fgPanXTo: number; fgPanYFrom: number; fgPanYTo: number;
  bgBlurFromPx: number; bgBlurToPx: number;
  subjectMaskSoftness: number;
  blurFromPx: number; blurToPx: number;
  transitionOut: TransitionPreset;
  whipDirection: "left" | "right";
  storyEffect: StoryEffect;
  maskShape: MaskShape;
  maskFromRadius: number; maskToRadius: number;
  maskX: number; maskY: number;
  maskHoldFrames: number; maskSoftness: number;
  freezeAtProgress: number; freezeHoldFrames: number;
  pathPoints: PanPoint[] | null;
  speedCurve: SpeedCurve;
  environmentEffect: EnvironmentEffect;
  environmentIntensity: number;
  saturationFrom: number; saturationTo: number;
  glowColor: string | null;
  glowX: number; glowY: number; glowOpacity: number; glowFlicker: number;
  vignette: number;
  fadeInFrames: number; fadeOutFrames: number;
};

export const DEFAULT_MOTION_RECIPE: MotionRecipe = {
  cameraEffect: "push_in",
  scaleFrom: 1.05, scaleTo: 1.2,
  panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0,
  rotationFromDeg: 0, rotationToDeg: 0,
  originX: 50, originY: 50,
  easing: "ease",
  motionBlurStrength: 0, shakeAmount: 0,
  staticZoomPercent: 0,
  subjectRegionX: 0.3, subjectRegionY: 0.25, subjectRegionW: 0.4, subjectRegionH: 0.5,
  depthEffect: "none",
  fgScaleFrom: 1, fgScaleTo: 1,
  fgPanXFrom: 0, fgPanXTo: 0, fgPanYFrom: 0, fgPanYTo: 0,
  bgBlurFromPx: 0, bgBlurToPx: 0,
  subjectMaskSoftness: 0.35,
  blurFromPx: 0, blurToPx: 0,
  transitionOut: "cut",
  whipDirection: "left",
  storyEffect: "none",
  maskShape: "none",
  maskFromRadius: 0, maskToRadius: 1,
  maskX: 0.5, maskY: 0.5,
  maskHoldFrames: 0, maskSoftness: 0.3,
  freezeAtProgress: 0.5, freezeHoldFrames: 0,
  pathPoints: null,
  speedCurve: "linear_pace",
  environmentEffect: "none",
  environmentIntensity: 0.35,
  saturationFrom: 1, saturationTo: 1,
  glowColor: null,
  glowX: 0.5, glowY: 0.5, glowOpacity: 0, glowFlicker: 0,
  // Optional accent, off by default — matches services/motion-engine's own
  // DEFAULT_RECIPE and motion_graphics_engine.py's MotionRecipe.vignette.
  vignette: 0,
  fadeInFrames: 14, fadeOutFrames: 14,
};

/** Parses a clip's `motionGraphicSettingsJson` into a `MotionRecipe`, filling in any
 * missing fields from `DEFAULT_MOTION_RECIPE` (forward-compatible with older persisted
 * recipes that predate a newly added field). Returns `DEFAULT_MOTION_RECIPE` as-is for
 * `null`/unparseable input rather than throwing — callers treat that as "start fresh". */
export function parseMotionRecipe(settingsJson: string | null): MotionRecipe {
  if (!settingsJson) return DEFAULT_MOTION_RECIPE;
  try {
    const parsed = JSON.parse(settingsJson) as Partial<MotionRecipe>;
    return { ...DEFAULT_MOTION_RECIPE, ...parsed };
  } catch {
    return DEFAULT_MOTION_RECIPE;
  }
}

export type MediaLibraryKind = "still" | "clip" | "audio";
export type MediaLibraryAssetRecord = {
  id: string;
  videoId: string;
  kind: MediaLibraryKind;
  originalName: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  createdAt: string;
};

export type TimelineMusicClipRecord = {
  id: string;
  mediaLibraryAssetId: string;
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  label: string;
  volumePercent: number;
  fadeInEnabled: boolean;
  fadeInSeconds: number;
  fadeOutEnabled: boolean;
  fadeOutSeconds: number;
  autoDuck: boolean;
  loopEnabled: boolean;
};

export type TextOverlayPosition =
  | "top-left" | "top-center" | "top-right"
  | "middle-left" | "center" | "middle-right"
  | "bottom-left" | "bottom-center" | "bottom-right";
export type TextBackgroundMode = "none" | "solid" | "blur";
export type TextOverlayAnimation = "none" | "fade" | "slide";
export type TimelineTextClipRecord = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  color: string;
  backgroundMode: TextBackgroundMode;
  backgroundColor: string;
  position: TextOverlayPosition;
  animation: TextOverlayAnimation;
};

export type LogoPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
export type TimelineLogoClipRecord = {
  id: string;
  mediaLibraryAssetId: string;
  startSeconds: number;
  endSeconds: number;
  position: LogoPosition;
  sizePercent: number;
  opacityPercent: number;
  showThroughout: boolean;
};
export type VeoResolution = "720p" | "1080p";
export type VideoAssetRecord = {
  id: string; videoId: string; groupId: string; sourceRenderId: string; version: number;
  parentVideoAssetId: string | null; kind: "generation" | "retimed" | "upload"; fileName: string; relativePath: string;
  resolution: VeoResolution | "original"; requestedDurationSeconds: number; veoDurationSeconds: number;
  actualDurationSeconds: number; veoModel: string; veoOperationName: string | null; prompt: string; createdAt: string;
};
export type AnimationJobRecord = {
  id: string;
  videoId: string;
  status: "queued" | "running" | "paused" | "stopped" | "completed" | "failed";
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: string;
  updatedAt: string;
  items: {
    id: string; videoId: string; clipId: string | null; groupId: string; sourceRenderId: string; resolution: VeoResolution;
    requestedDurationSeconds: number; veoDurationSeconds: number; prompt: string; status: string; attempts: number;
    lastError: string | null; videoAssetId: string | null;
  }[];
};
export type CaptionStyle = {
  fontFamily?: string;
  fontSizePx?: number;
  bold?: boolean;
  color?: string;
  /** Blend opacity (0-100) applied to the text fill and stroke. */
  opacity?: number;
  outlineColor?: string;
  outlineWidthPx?: number;
  shadow?: {
    enabled?: boolean;
    color?: string;
    /** 0-100 */
    opacity?: number;
    /** 0-100 */
    blur?: number;
    /** px */
    distance?: number;
    /** degrees, 0 = right, clockwise */
    angle?: number;
  };
  position?: "bottom" | "middle" | "top";
  wordHighlight?: { enabled?: boolean; color?: string };
};
export type TimelineCaptionClipRecord = {
  id: string; sourceChunkIndex: number | null; text: string; ordinal: number; startSeconds: number; endSeconds: number;
  style: CaptionStyle | null;
  /** Real per-word timestamps carried over from the source chunk; null once
   * hand-edited or for a fully user-authored caption. */
  words: CaptionWordRecord[] | null;
};
export type TimelineRecord = {
  videoId: string; durationSeconds: number; playheadSeconds: number; zoom: number; updatedAt: string;
  clips: TimelineClipRecord[];
  captionClips: TimelineCaptionClipRecord[];
  captionStyle: CaptionStyle;
  narrationOffsetSeconds: number;
  musicClips: TimelineMusicClipRecord[];
  textClips: TimelineTextClipRecord[];
  logoClips: TimelineLogoClipRecord[];
  musicMasterVolumePercent: number;
  musicDuckSensitivityPercent: number;
  /** When true (the default), Stills clips can't be reordered by dragging —
   * only resized/effects-edited — keeping them locked to narration sync. */
  sequenceLocked: boolean;
  narrationVolumePercent: number;
  narrationTrimStartSeconds: number;
  narrationTrimEndSeconds: number;
};

type BrowserData = {
  channels: ChannelRecord[];
  videos: VideoRecord[];
  trashedChannels?: ChannelRecord[];
  trashedVideos?: VideoRecord[];
  resume: ResumeRecord | null;
  inputs?: Record<string, VideoInputsRecord>;
};

const STORAGE_KEY = "auto-gen-studio.dev-projects";
export const isTauri = () => "__TAURI_INTERNALS__" in window;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function readBrowserData(): BrowserData {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return JSON.parse(stored) as BrowserData;
  return { channels: [], videos: [], trashedChannels: [], trashedVideos: [], resume: null };
}

function writeBrowserData(data: BrowserData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/** Web-demo mirror of the Rust repository's `assign_scene_ids`: recomputes
 * every group's sceneId by containment against `scenes` (a group belongs to
 * whichever scene's sentence range contains its first sentence). Mutates
 * `groups` in place. */
function assignSceneIds(groups: PlanGroupRecord[], scenes: PlanSceneRecord[]): void {
  for (const group of groups) {
    const first = group.sentenceIds[0];
    group.sceneId = (first && scenes.find((scene) => scene.sentenceIds.includes(first))?.id) ?? null;
  }
}

/** Web-demo mirror of the Rust repository's `renumber_scene_sentence_ids` —
 * applies the same per-sentence-id renumber function split/merge already use
 * for groups to every scene's own sentenceIds, dropping any scene left with
 * none (mirrors groups' own empty-group drop). */
function renumberSceneSentenceIds(scenes: PlanSceneRecord[], renumber: (id: string) => string[]): PlanSceneRecord[] {
  return scenes
    .map((scene) => ({ ...scene, sentenceIds: scene.sentenceIds.flatMap(renumber) }))
    .filter((scene) => scene.sentenceIds.length)
    .map((scene, index) => ({ ...scene, ordinal: index + 1 }));
}

function formatSrtTimestamp(seconds: number): string {
  const ms = Math.round((seconds % 1) * 1000);
  const whole = Math.floor(seconds);
  const s = whole % 60;
  const m = Math.floor(whole / 60) % 60;
  const h = Math.floor(whole / 3600);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

export const projectsClient = {
  async getApplicationVersion(): Promise<string> {
    if (isTauri()) return invoke("application_version");
    return "";
  },
  async startupDiagnostic(): Promise<string | null> {
    if (isTauri()) return invoke("startup_diagnostic");
    return null;
  },
  async listChannels(includeTrashed = false): Promise<ChannelRecord[]> {
    if (isTauri()) return invoke("list_channels", { includeTrashed });
    const data = readBrowserData();
    return includeTrashed ? data.trashedChannels ?? [] : data.channels;
  },
  async createChannel(name: string, description?: string): Promise<ChannelRecord> {
    if (isTauri()) return invoke("create_channel", { name, description });
    const data = readBrowserData();
    const channel: ChannelRecord = {
      id: id(), name, description: description || null, videoCount: 0,
      createdAt: now(), updatedAt: now(),
    };
    data.channels.unshift(channel);
    writeBrowserData(data);
    return channel;
  },
  async listVideos(channelId: string, includeTrashed = false): Promise<VideoRecord[]> {
    if (isTauri()) return invoke("list_videos", { channelId, includeTrashed });
    const data = readBrowserData();
    const source = includeTrashed ? data.trashedVideos ?? [] : data.videos;
    return source.filter((video) => video.channelId === channelId);
  },
  async getVideoProgress(videoId: string): Promise<VideoProgressRecord> {
    if (isTauri()) return invoke("get_video_progress", { videoId });
    return { videoId, totalStills: 0, generatedStills: 0, previewRenderId: null };
  },
  async createVideo(channelId: string, title: string): Promise<VideoRecord> {
    if (isTauri()) return invoke("create_video", { channelId, title });
    const data = readBrowserData();
    const video: VideoRecord = {
      id: id(), channelId, title, stage: "inputs", progress: 0,
      createdAt: now(), updatedAt: now(),
    };
    data.videos.unshift(video);
    const channel = data.channels.find((candidate) => candidate.id === channelId);
    if (channel) channel.videoCount += 1;
    writeBrowserData(data);
    return video;
  },
  async getResume(): Promise<ResumeRecord | null> {
    if (isTauri()) return invoke("get_resume_state");
    return readBrowserData().resume;
  },
  async setResume(channelId: string, videoId: string, stage: AppStage) {
    if (isTauri()) {
      return invoke<ResumeRecord>("set_resume_state", { channelId, videoId, stage });
    }
    const data = readBrowserData();
    data.resume = { channelId, videoId, stage, updatedAt: now() };
    const video = data.videos.find((candidate) => candidate.id === videoId);
    if (video) {
      video.stage = stage;
      video.updatedAt = now();
    }
    writeBrowserData(data);
    return data.resume;
  },
  async trashChannel(channelId: string) {
    if (isTauri()) return invoke<void>("trash_channel", { id: channelId });
    const data = readBrowserData();
    const channel = data.channels.find((candidate) => candidate.id === channelId);
    if (channel) (data.trashedChannels ??= []).push(channel);
    data.channels = data.channels.filter((candidate) => candidate.id !== channelId);
    writeBrowserData(data);
  },
  async trashVideo(videoId: string) {
    if (isTauri()) return invoke<void>("trash_video", { id: videoId });
    const data = readBrowserData();
    const video = data.videos.find((candidate) => candidate.id === videoId);
    if (video) (data.trashedVideos ??= []).push(video);
    data.videos = data.videos.filter((candidate) => candidate.id !== videoId);
    const channel = data.channels.find((candidate) => candidate.id === video?.channelId);
    if (channel) channel.videoCount = Math.max(0, channel.videoCount - 1);
    writeBrowserData(data);
  },
  async restoreChannel(channelId: string) {
    if (isTauri()) return invoke<void>("restore_channel", { id: channelId });
    const data = readBrowserData();
    const channel = data.trashedChannels?.find((candidate) => candidate.id === channelId);
    if (channel) data.channels.unshift(channel);
    data.trashedChannels = data.trashedChannels?.filter((candidate) => candidate.id !== channelId);
    writeBrowserData(data);
  },
  async restoreVideo(videoId: string) {
    if (isTauri()) return invoke<void>("restore_video", { id: videoId });
    const data = readBrowserData();
    const video = data.trashedVideos?.find((candidate) => candidate.id === videoId);
    if (video) data.videos.unshift(video);
    data.trashedVideos = data.trashedVideos?.filter((candidate) => candidate.id !== videoId);
    writeBrowserData(data);
  },
  async renameChannel(channelId: string, name: string): Promise<void> {
    if (isTauri()) return invoke("rename_channel", { id: channelId, name });
    const data = readBrowserData();
    const channel = data.channels.find((c) => c.id === channelId);
    if (channel) { channel.name = name; channel.updatedAt = now(); }
    writeBrowserData(data);
  },
  async renameVideo(videoId: string, title: string): Promise<void> {
    if (isTauri()) return invoke("rename_video", { id: videoId, title });
    const data = readBrowserData();
    const video = data.videos.find((v) => v.id === videoId);
    if (video) { video.title = title; video.updatedAt = now(); }
    writeBrowserData(data);
  },
  async permanentlyDeleteChannel(channelId: string): Promise<void> {
    if (isTauri()) return invoke("permanent_delete_channel", { id: channelId });
    const data = readBrowserData();
    data.trashedChannels = data.trashedChannels?.filter((c) => c.id !== channelId);
    writeBrowserData(data);
  },
  async permanentlyDeleteVideo(videoId: string): Promise<void> {
    if (isTauri()) return invoke("permanent_delete_video", { id: videoId });
    const data = readBrowserData();
    data.trashedVideos = data.trashedVideos?.filter((v) => v.id !== videoId);
    writeBrowserData(data);
  },
  async createSnapshot(videoId: string, payload: unknown) {
    if (isTauri()) {
      return invoke<string>("create_video_snapshot", {
        videoId,
        payloadJson: JSON.stringify(payload),
      });
    }
    return id();
  },
  async getVideoInputs(videoId: string): Promise<VideoInputsRecord> {
    if (isTauri()) return invoke("get_video_inputs", { videoId });
    const data = readBrowserData();
    return data.inputs?.[videoId] ?? {
      videoId, scriptText: "", pacingSeconds: 8, pacingPreset: "balanced", pacingMinSeconds: 6, pacingMaxSeconds: 10, audio: null, references: [], updatedAt: now(), planMatchesCurrentInputs: null,
    };
  },
  async getImageWorkspace(videoId: string): Promise<ImageWorkspaceRecord> {
    if (isTauri()) return invoke("get_image_workspace", { videoId });
    const plan = await this.getVisualPlan(videoId);
    return {
      videoId,
      sentences: plan.sentences,
      groups: plan.groups.map((group) => ({ group, educationalPlan: null, promptVersions: [], imageRenders: [] })),
      settings: [],
      scenes: plan.scenes,
    };
  },
  async saveAppSetting(key: string, value: string): Promise<void> {
    if (isTauri()) return invoke("save_app_setting", { key, value });
    localStorage.setItem(`${STORAGE_KEY}.setting.${key}`, value);
  },
  async getAppSetting(key: string): Promise<string | null> {
    if (isTauri()) return invoke("get_app_setting", { key });
    return localStorage.getItem(`${STORAGE_KEY}.setting.${key}`);
  },
  async saveProviderKey(provider: "openai" | "gemini", apiKey: string): Promise<void> {
    if (isTauri()) return invoke("save_provider_key", { provider, apiKey });
    localStorage.setItem(`${STORAGE_KEY}.key-status.${provider}`, apiKey ? "configured" : "");
  },
  async getProviderKeyStatus(provider: "openai" | "gemini"): Promise<ProviderKeyStatusRecord> {
    if (isTauri()) return invoke("get_provider_key_status", { provider });
    return { provider, configured: localStorage.getItem(`${STORAGE_KEY}.key-status.${provider}`) === "configured" };
  },
  async testProviderKey(provider: "openai" | "gemini"): Promise<void> {
    if (isTauri()) return invoke("test_provider_key", { provider });
    throw new Error("Testing a provider key requires the native application.");
  },
  async createPromptVersion(
    videoId: string,
    groupId: string,
    settingsJson: string,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<PromptVersionRecord> {
    if (isTauri()) {
      return invoke("create_prompt_version", {
        videoId,
        groupId,
        settingsJson,
        systemPrompt,
        userPrompt,
      });
    }
    return {
      id: id(),
      videoId,
      groupId,
      version: 1,
      settingsJson,
      systemPrompt,
      userPrompt,
      createdAt: now(),
    };
  },
  async listPromptVersions(videoId: string, groupId: string): Promise<PromptVersionRecord[]> {
    if (isTauri()) return invoke("list_prompt_versions", { videoId, groupId });
    return [];
  },
  async listImageRenders(videoId: string, groupId: string): Promise<ImageRenderRecord[]> {
    if (isTauri()) return invoke("list_image_renders", { videoId, groupId });
    return [];
  },
  async generateImageRender(
    videoId: string,
    groupId: string,
    promptVersionId: string,
    systemPrompt: string,
    userPrompt: string,
    settingsJson: string,
  ): Promise<ImageRenderRecord> {
    if (isTauri()) {
      return invoke("generate_image_render", {
        videoId,
        groupId,
        promptVersionId,
        systemPrompt,
        userPrompt,
        settingsJson,
      });
    }
    return {
      id: id(),
      videoId,
      groupId,
      version: 1,
      promptVersionId,
      fileName: "render-v1.png",
      relativePath: `renders/${groupId}/render-v1.png`,
      parentRenderId: null,
      editInstruction: null,
      kind: "generation",
      isFinal: true,
      editStrength: null,
      maskPath: null,
      maskUsed: false,
      createdAt: now(),
      subjectX: null,
      subjectY: null,
    };
  },
  async editImageRender(sourceRenderId: string, instruction: string, maskDataUrl?: string, editStrength = "Low"): Promise<ImageRenderRecord> {
    if (isTauri()) return invoke("edit_image_render", { sourceRenderId, instruction, maskDataUrl: maskDataUrl || null, editStrength });
    throw new Error("Image editing requires the native application.");
  },
  async getRenderDataUrl(renderId: string): Promise<string> {
    if (isTauri()) return invoke("get_render_data_url", { renderId });
    return "";
  },
  async getRenderFilePath(renderId: string): Promise<string> {
    if (isTauri()) return invoke("get_render_file_path", { renderId });
    return "";
  },
  async pickDownloadFolder(): Promise<string | null> {
    if (isTauri()) return invoke("pick_download_folder");
    return null;
  },
  async pickExportDestination(defaultName: string, defaultDir?: string | null): Promise<string | null> {
    if (isTauri()) return invoke("pick_export_destination", { defaultName, defaultDir: defaultDir ?? null });
    return null;
  },
  async copyRenderToFolder(renderId: string, folderPath: string): Promise<string> {
    if (isTauri()) return invoke("copy_render_to_folder", { renderId, folderPath });
    throw new Error("Download requires the native application.");
  },
  async exportLatestStills(videoId: string): Promise<ExportResultRecord | null> {
    if (isTauri()) return invoke("export_latest_stills", { videoId });
    throw new Error("Export requires the native application.");
  },
  async exportProjectBundle(videoId: string): Promise<ExportResultRecord | null> {
    if (isTauri()) return invoke("export_project_bundle", { videoId });
    throw new Error("Export requires the native application.");
  },
  async importProjectBundle(channelId: string): Promise<VideoRecord | null> {
    if (isTauri()) return invoke("import_project_bundle", { channelId });
    throw new Error("Import requires the native application.");
  },
  async importAssetFolder(): Promise<VideoRecord | null> {
    if (isTauri()) return invoke("import_asset_folder");
    throw new Error("Import requires the native application.");
  },
  async buildTimeline(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("build_timeline", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async getTimeline(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("get_timeline", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async updateTimelineView(videoId: string, playhead: number, zoom: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_timeline_view", { videoId, playhead, zoom });
    throw new Error("Timeline requires the native application.");
  },
  async updateTimelineClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_timeline_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async setNarrationOffset(videoId: string, offsetSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_narration_offset", { videoId, offsetSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async populateTimelineFromSources(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("populate_timeline_from_sources", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async addStillsClip(videoId: string, groupId: string, startSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_stills_clip", { videoId, groupId, startSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async addCaptionClip(videoId: string, chunkIndex: number | null, text: string | null, startSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_caption_clip", { videoId, chunkIndex, text, startSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async updateTimelineCaptionClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_timeline_caption_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async updateCaptionClipText(videoId: string, clipId: string, text: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_caption_clip_text", { videoId, clipId, text });
    throw new Error("Timeline requires the native application.");
  },
  async splitCaptionClip(videoId: string, clipId: string, splitAtSeconds: number, leftText: string, rightText: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("split_caption_clip", { videoId, clipId, splitAtSeconds, leftText, rightText });
    throw new Error("Timeline requires the native application.");
  },
  async mergeCaptionClips(videoId: string, firstClipId: string, secondClipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("merge_caption_clips", { videoId, firstClipId, secondClipId });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineCaptionStyle(videoId: string, style: CaptionStyle): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_caption_style", { videoId, style });
    throw new Error("Timeline requires the native application.");
  },
  async setCaptionClipStyle(videoId: string, clipId: string, style: CaptionStyle | null): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_caption_clip_style", { videoId, clipId, style });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipRender(videoId: string, clipId: string, renderId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_render", { videoId, clipId, renderId });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipMotion(videoId: string, clipId: string, motionPreset: MotionPreset): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_motion", { videoId, clipId, motionPreset });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipTransition(videoId: string, clipId: string, transitionIn: TransitionPreset): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_transition", { videoId, clipId, transitionIn });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipTransitionOut(videoId: string, clipId: string, transitionOut: TransitionPreset): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_transition_out", { videoId, clipId, transitionOut });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipMotionIntensity(videoId: string, clipId: string, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_motion_intensity", { videoId, clipId, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async applyMotionToAllClips(videoId: string, motionPreset: MotionPreset, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_motion_to_all_clips", { videoId, motionPreset, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipColorFilter(videoId: string, clipId: string, preset: ColorFilterPreset, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_color_filter", { videoId, clipId, preset, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipMotionGraphic(videoId: string, clipId: string, effect: MotionGraphicEffect | null, settingsJson: string | null, reason: string | null): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_motion_graphic", { videoId, clipId, effect, settingsJson, reason });
    throw new Error("Timeline requires the native application.");
  },
  /** Discards whatever a manual edit in MotionSettingsPanel has done since,
   * restoring the clip's live motion graphic to exactly what Auto Motion
   * last composed for it. Rejects if this clip was never analyzed by Auto
   * Motion (e.g. one built entirely by hand via "start from scratch") — see
   * `motionGraphicAiSnapshotJson`, which is what gates showing the button
   * for this in the UI. */
  async resetTimelineClipMotionGraphicToAi(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("reset_timeline_clip_motion_graphic_to_ai", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async clearMotionGraphicsForAllClips(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("clear_motion_graphics_for_all_clips", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async applyColorFilterToAllClips(videoId: string, preset: ColorFilterPreset, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_color_filter_to_all_clips", { videoId, preset, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async applyTransitionInToAllClips(videoId: string, transitionIn: TransitionPreset): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_transition_in_to_all_clips", { videoId, transitionIn });
    throw new Error("Timeline requires the native application.");
  },
  async applyTransitionOutToAllClips(videoId: string, transitionOut: TransitionPreset): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_transition_out_to_all_clips", { videoId, transitionOut });
    throw new Error("Timeline requires the native application.");
  },
  async setTimelineClipTransitionIntensity(videoId: string, clipId: string, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_timeline_clip_transition_intensity", { videoId, clipId, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async applyTransitionIntensityToAllClips(videoId: string, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_transition_intensity_to_all_clips", { videoId, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async applyMotionIntensityToAllClips(videoId: string, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("apply_motion_intensity_to_all_clips", { videoId, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async alternateZoomForAllClips(videoId: string, intensity: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("alternate_zoom_for_all_clips", { videoId, intensity });
    throw new Error("Timeline requires the native application.");
  },
  async extrapolateStillsToFillGaps(videoId: string, totalDurationSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("extrapolate_stills_to_fill_gaps", { videoId, totalDurationSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async resetStillsTimingToNatural(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("reset_stills_timing_to_natural", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async deleteTimelineClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("delete_timeline_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async duplicateTimelineClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("duplicate_timeline_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async deleteTimelineCaptionClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("delete_timeline_caption_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async clearTimelineTrack(videoId: string, track: "stills" | "captions" | "music" | "overlays"): Promise<TimelineRecord> {
    if (isTauri()) return invoke("clear_timeline_track", { videoId, track });
    throw new Error("Timeline requires the native application.");
  },
  async resetTimelineToDefault(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("reset_timeline_to_default", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async restoreTimelineSnapshot(videoId: string, snapshot: TimelineRecord): Promise<TimelineRecord> {
    if (isTauri()) return invoke("restore_timeline_snapshot", { videoId, snapshotJson: JSON.stringify(snapshot) });
    throw new Error("Timeline requires the native application.");
  },
  // ===== Media library (Editor tab: Stills / Clips / Audio tabs) =====
  async pickAndImportMediaLibraryAsset(videoId: string, kind: MediaLibraryKind | null): Promise<MediaLibraryAssetRecord | null> {
    if (isTauri()) return invoke("pick_and_import_media_library_asset", { videoId, kind });
    throw new Error("Media library import requires the native application.");
  },
  async listMediaLibraryAssets(videoId: string, kind: MediaLibraryKind | null): Promise<MediaLibraryAssetRecord[]> {
    if (isTauri()) return invoke("list_media_library_assets", { videoId, kind });
    return [];
  },
  async removeMediaLibraryAsset(assetId: string): Promise<void> {
    if (isTauri()) return invoke("remove_media_library_asset", { assetId });
  },
  async getMediaLibraryAssetFilePath(assetId: string): Promise<string> {
    if (isTauri()) return invoke("get_media_library_asset_file_path", { assetId });
    return "";
  },
  /** Removes steady-state background noise (hiss, hum, static) from an
   * Audio-tab asset. Non-destructive — lands as a new "(denoised)" asset
   * alongside the original rather than replacing it. */
  async denoiseMediaLibraryAsset(assetId: string): Promise<MediaLibraryAssetRecord> {
    if (isTauri()) return invoke("denoise_media_library_asset", { assetId });
    throw new Error("Background noise removal requires the native application.");
  },
  async listVideoAssets(videoId: string): Promise<VideoAssetRecord[]> {
    if (isTauri()) return invoke("list_video_assets", { videoId });
    return [];
  },
  async addVideoAssetClipToStillsTrack(videoId: string, videoAssetId: string, startSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_video_asset_clip_to_stills_track", { videoId, videoAssetId, startSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async addLibraryAssetToStillsTrack(videoId: string, mediaLibraryAssetId: string, startSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_library_asset_to_stills_track", { videoId, mediaLibraryAssetId, startSeconds });
    throw new Error("Timeline requires the native application.");
  },
  // ===== Music track =====
  async addMusicClip(videoId: string, mediaLibraryAssetId: string, startSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_music_clip", { videoId, mediaLibraryAssetId, startSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async updateMusicClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_music_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async setMusicClipSettings(
    videoId: string, clipId: string, volumePercent: number,
    fadeInEnabled: boolean, fadeInSeconds: number, fadeOutEnabled: boolean, fadeOutSeconds: number,
    autoDuck: boolean, loopEnabled: boolean,
  ): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_music_clip_settings", { videoId, clipId, volumePercent, fadeInEnabled, fadeInSeconds, fadeOutEnabled, fadeOutSeconds, autoDuck, loopEnabled });
    throw new Error("Timeline requires the native application.");
  },
  async setSequenceLocked(videoId: string, locked: boolean): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_sequence_locked", { videoId, locked });
    throw new Error("Timeline requires the native application.");
  },
  async setNarrationSettings(videoId: string, volumePercent: number, trimStartSeconds: number, trimEndSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_narration_settings", { videoId, volumePercent, trimStartSeconds, trimEndSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async deleteMusicClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("delete_music_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async setMusicMasterSettings(videoId: string, masterVolumePercent: number, duckSensitivityPercent: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_music_master_settings", { videoId, masterVolumePercent, duckSensitivityPercent });
    throw new Error("Timeline requires the native application.");
  },
  // ===== Overlays track: text =====
  async addTextOverlayClip(videoId: string, atSeconds: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_text_overlay_clip", { videoId, atSeconds });
    throw new Error("Timeline requires the native application.");
  },
  async updateTextOverlayClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_text_overlay_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async setTextOverlayStyle(
    videoId: string, clipId: string, text: string, fontFamily: string, fontSizePx: number,
    bold: boolean, italic: boolean, color: string, backgroundMode: TextBackgroundMode, backgroundColor: string,
    position: TextOverlayPosition, animation: TextOverlayAnimation,
  ): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_text_overlay_style", {
      videoId, clipId, text, fontFamily, fontSizePx, bold, italic, color, backgroundMode, backgroundColor, position, animation,
    });
    throw new Error("Timeline requires the native application.");
  },
  async deleteTextOverlayClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("delete_text_overlay_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  // ===== Overlays track: logo/watermark =====
  async addLogoClip(videoId: string, mediaLibraryAssetId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("add_logo_clip", { videoId, mediaLibraryAssetId });
    throw new Error("Timeline requires the native application.");
  },
  async updateLogoClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_logo_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async setLogoClipStyle(videoId: string, clipId: string, position: LogoPosition, sizePercent: number, opacityPercent: number, showThroughout: boolean): Promise<TimelineRecord> {
    if (isTauri()) return invoke("set_logo_clip_style", { videoId, clipId, position, sizePercent, opacityPercent, showThroughout });
    throw new Error("Timeline requires the native application.");
  },
  async deleteLogoClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("delete_logo_clip", { videoId, clipId });
    throw new Error("Timeline requires the native application.");
  },
  async removeAllClipEffects(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("remove_all_clip_effects", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async probeNarrationDuration(videoId: string): Promise<number> {
    if (isTauri()) return invoke("probe_narration_duration", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async detectRenderSubject(videoId: string, renderId: string): Promise<[number, number]> {
    if (isTauri()) return invoke("detect_render_subject", { videoId, renderId });
    throw new Error("Timeline requires the native application.");
  },
  async exportTimelineVideo(videoId: string, destinationPath: string, options: ExportSettingsRecord): Promise<string | null> {
    if (isTauri()) return invoke("export_timeline_video", { videoId, destinationPath, options });
    throw new Error("Video export requires the native application.");
  },
  async listExportJobs(videoId: string): Promise<ExportJobRecord[]> {
    if (isTauri()) return invoke("list_export_jobs", { videoId });
    return [];
  },
  async revealInFileManager(path: string): Promise<void> {
    if (isTauri()) return invoke("reveal_in_file_manager", { path });
  },
  async getAppDataDir(): Promise<string> {
    if (isTauri()) return invoke("get_app_data_dir");
    return "";
  },
  async pickExportProjectDestination(): Promise<string | null> {
    if (isTauri()) return invoke("pick_export_project_destination");
    return null;
  },
  async exportTimelineProject(videoId: string, destinationPath: string): Promise<string> {
    if (isTauri()) return invoke("export_timeline_project", { videoId, destinationPath });
    throw new Error("Project export requires the native application.");
  },
  async cancelTimelineExport(videoId: string): Promise<boolean> {
    if (isTauri()) return invoke("cancel_timeline_export", { videoId });
    return false;
  },
  /** Creates a job for exactly `groupIds`, forced — every one becomes a job
   * item using its current newest prompt, whether or not that still's
   * render is already up to date. See pendingStillIds for computing a
   * sensible default selection instead of blindly passing every still. */
  async createImageJob(videoId: string, groupIds: string[]): Promise<ImageJobRecord> {
    if (isTauri()) return invoke("create_image_job", { videoId, groupIds });
    throw new Error("Bulk jobs require the native application.");
  },
  async getLatestImageJob(videoId: string): Promise<ImageJobRecord | null> {
    if (isTauri()) return invoke("get_latest_image_job", { videoId });
    return null;
  },
  /** Queues one still for generation on the standalone single-still queue
   * (fire-and-forget — the always-on backend dispatcher processes it in the
   * background; poll `listSingleStillGenerations` for status). */
  async enqueueSingleStillGeneration(videoId: string, groupId: string, promptVersionId: string): Promise<SingleStillGenerationRecord> {
    if (isTauri()) return invoke("enqueue_single_still_generation", { videoId, groupId, promptVersionId });
    throw new Error("Single-still generation requires the native application.");
  },
  async listSingleStillGenerations(videoId: string): Promise<SingleStillGenerationRecord[]> {
    if (isTauri()) return invoke("list_single_still_generations", { videoId });
    return [];
  },
  /** Every still whose newest render is missing or stale relative to its
   * newest prompt/educational plan — used purely to compute the Bulk
   * Generation panel's default pre-checked selection (empty/outdated stills
   * start checked; up-to-date ones start unchecked but stay selectable). */
  async pendingStillIds(videoId: string): Promise<string[]> {
    if (isTauri()) return invoke("pending_still_ids", { videoId });
    return [];
  },
  async controlImageJob(jobId: string, action: "pause" | "resume" | "stop" | "cancel"): Promise<ImageJobRecord> {
    if (isTauri()) return invoke("control_image_job", { jobId, action });
    throw new Error("Bulk jobs require the native application.");
  },
  /** Adds a new request to the back of a video's Bulk Generation queue —
   * freezes style directive, creative instruction, base image settings, and
   * scope (`groupIds`) into a durable snapshot immediately, along with the
   * video's current dials/roster/cast assignments, so later edits to Global
   * Settings/Roster can never bleed into an already-queued request. */
  async enqueueBulkGenerationRequest(
    videoId: string, styleDirective: string, baseSettingsJson: string, creativeInstruction: string, groupIds: string[],
  ): Promise<BulkGenerationRequestRecord> {
    if (isTauri()) return invoke("enqueue_bulk_generation_request", { videoId, styleDirective, baseSettingsJson, creativeInstruction, groupIds });
    throw new Error("Bulk generation requires the native application.");
  },
  async listBulkGenerationRequests(videoId: string): Promise<BulkGenerationRequestRecord[]> {
    if (isTauri()) return invoke("list_bulk_generation_requests", { videoId });
    return [];
  },
  /** Only a request that hasn't started yet (`status === "pending"`) can be
   * cancelled this way — an active one is stopped via `controlImageJob` on
   * its `imageJobId` instead. */
  async cancelBulkGenerationRequest(requestId: string): Promise<void> {
    if (isTauri()) return invoke("cancel_bulk_generation_request", { requestId });
    throw new Error("Bulk generation requires the native application.");
  },
  async reorderBulkGenerationRequest(requestId: string, direction: "up" | "down"): Promise<void> {
    if (isTauri()) return invoke("reorder_bulk_generation_request", { requestId, direction });
    throw new Error("Bulk generation requires the native application.");
  },
  /** The queue-runner's single entry point — call in a loop while a video's
   * queue is non-empty (see `runQueueRunner` in App.tsx). */
  async advanceBulkGenerationQueue(videoId: string): Promise<BulkQueueAdvanceResultRecord> {
    if (isTauri()) return invoke("advance_bulk_generation_queue", { videoId });
    throw new Error("Bulk generation requires the native application.");
  },
  async createAnimationJob(videoId: string, clipId: string, resolution: VeoResolution, prompt: string): Promise<AnimationJobRecord> {
    if (isTauri()) return invoke("create_animation_job", { videoId, clipId, resolution, prompt });
    throw new Error("Animation generation requires the native application.");
  },
  /** Animate stage counterpart of createAnimationJob — targets stills
   * directly (no timeline clip needed yet). */
  async createAnimationBulkJob(videoId: string, resolution: VeoResolution, items: { groupId: string; prompt: string }[]): Promise<AnimationJobRecord> {
    if (isTauri()) return invoke("create_animation_bulk_job", { videoId, resolution, items });
    throw new Error("Animation generation requires the native application.");
  },
  async suggestAnimationPrompt(videoId: string, groupId: string): Promise<string> {
    if (isTauri()) return invoke("suggest_animation_prompt", { videoId, groupId });
    throw new Error("Prompt suggestions require the native application.");
  },
  async explainMotionGraphicChoice(videoId: string, groupId: string, effectLabel: string, effectSummary: string): Promise<string> {
    if (isTauri()) return invoke("explain_motion_graphic_choice", { videoId, groupId, effectLabel, effectSummary });
    throw new Error("This requires the native application.");
  },
  async getLatestAnimationJob(videoId: string): Promise<AnimationJobRecord | null> {
    if (isTauri()) return invoke("get_latest_animation_job", { videoId });
    return null;
  },
  async controlAnimationJob(jobId: string, action: "pause" | "resume" | "stop" | "cancel"): Promise<AnimationJobRecord> {
    if (isTauri()) return invoke("control_animation_job", { jobId, action });
    throw new Error("Animation generation requires the native application.");
  },
  async retimeAnimationClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("retime_animation_clip", { videoId, clipId });
    throw new Error("Adjusting an animation's duration requires the native application.");
  },
  async importAnimationClip(videoId: string, clipId: string): Promise<TimelineRecord | null> {
    if (isTauri()) return invoke("import_animation_clip", { videoId, clipId });
    throw new Error("Uploading an animation requires the native application.");
  },
  async revertAnimationClipToStill(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("revert_animation_clip_to_still", { videoId, clipId });
    throw new Error("Undoing an animation requires the native application.");
  },
  async restoreAnimationClip(videoId: string, clipId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("restore_animation_clip", { videoId, clipId });
    throw new Error("Restoring an animation requires the native application.");
  },
  async getVideoAssetFilePath(videoAssetId: string): Promise<string> {
    if (isTauri()) return invoke("get_video_asset_file_path", { videoAssetId });
    return "";
  },
  async getVideoAssetRecord(videoAssetId: string): Promise<VideoAssetRecord> {
    if (isTauri()) return invoke("get_video_asset_record", { videoAssetId });
    throw new Error("Animation clips require the native application.");
  },
  async saveVideoInputs(videoId: string, scriptText: string, pacingSeconds: number) {
    if (isTauri()) return invoke<VideoInputsRecord>("save_video_inputs", { videoId, scriptText, pacingSeconds });
    const data = readBrowserData();
    const existing = data.inputs?.[videoId] ?? {
      videoId, scriptText: "", pacingSeconds: 8, pacingPreset: "balanced" as const, pacingMinSeconds: 6, pacingMaxSeconds: 10, audio: null, references: [], updatedAt: now(), planMatchesCurrentInputs: null,
    };
    const inputs = { ...existing, scriptText, pacingSeconds, updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return inputs;
  },
  async saveVideoPacing(videoId: string, preset: "calm" | "balanced" | "fast" | "custom" | "per-sentence", minSeconds: number, maxSeconds: number) {
    if (isTauri()) return invoke<VideoInputsRecord>("save_video_pacing", { videoId, preset, minSeconds, maxSeconds });
    const data = readBrowserData();
    const existing = await this.getVideoInputs(videoId);
    const inputs = { ...existing, pacingPreset: preset, pacingMinSeconds: minSeconds, pacingMaxSeconds: maxSeconds, pacingSeconds: Math.round((minSeconds + maxSeconds) / 2), updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return inputs;
  },
  async pickAndImportAsset(videoId: string, kind: "audio" | "reference" | "roster-reference") {
    if (isTauri()) return invoke<InputAssetRecord | null>("pick_and_import_asset", { videoId, kind });
    return null;
  },
  async deletePromptVersion(promptVersionId: string): Promise<void> {
    if (isTauri()) return invoke("delete_prompt_version", { promptVersionId });
  },
  async getAssetDataUrl(assetId: string): Promise<string> {
    if (isTauri()) return invoke("get_asset_data_url", { assetId });
    return "";
  },
  async getAssetFilePath(assetId: string): Promise<string> {
    if (isTauri()) return invoke("get_asset_file_path", { assetId });
    return "";
  },
  async setFinalRender(renderId: string, isFinal: boolean): Promise<ImageRenderRecord> {
    if (isTauri()) return invoke("set_final_render", { renderId, isFinal });
    throw new Error("Final image selection requires the native application.");
  },
  async deleteImageRender(renderId: string): Promise<void> {
    if (isTauri()) return invoke("delete_image_render", { renderId });
  },
  async resetImageWorkflow(videoId: string): Promise<void> {
    if (isTauri()) return invoke("reset_image_workflow", { videoId });
  },
  async suggestImagePrompt(
    videoId: string,
    groupId: string,
    settingsJson: string,
    styleDirective: string,
  ): Promise<string> {
    if (isTauri()) return invoke("suggest_image_prompt", { videoId, groupId, settingsJson, styleDirective });
    const plan = await this.getVisualPlan(videoId);
    const group = plan.groups.find((item) => item.id === groupId);
    const text = group?.sentenceIds.map((sentenceId) => plan.sentences.find((sentence) => sentence.id === sentenceId)?.text).filter(Boolean).join(" ");
    return `Create a direct visual depiction of: ${text ?? "this narration"}.`;
  },
  async planEducationalVisual(
    videoId: string,
    groupId: string,
    settingsJson: string,
    styleDirective: string,
  ): Promise<EducationalVisualPlanRecord> {
    if (isTauri()) return invoke("plan_educational_visual", { videoId, groupId, settingsJson, styleDirective });
    throw new Error("Educational visual planning requires the native application.");
  },
  async planWholeVideoEducationalVisuals(
    videoId: string,
    settingsJson: string,
    styleDirective: string,
    strategyMode: VisualStrategyMode,
  ): Promise<WholeVideoEducationalPlanRecord> {
    if (isTauri()) return invoke("plan_whole_video_educational_visuals", { videoId, settingsJson, styleDirective, strategyMode });
    throw new Error("Whole-video educational planning requires the native application.");
  },
  async extractReferenceStyle(assetId: string): Promise<StyleExtractionRecord> {
    if (isTauri()) return invoke("extract_reference_style", { assetId });
    throw new Error("Style extraction requires the native application.");
  },
  async extractImageSettingsFromDirective(directive: string): Promise<StyleExtractionRecord> {
    if (isTauri()) return invoke("extract_image_settings_from_directive", { directive });
    throw new Error("Image settings extraction requires the native application.");
  },
  async suggestStillPrompt(videoId: string, groupId: string, styleDirective: string, baseSettingsJson: string): Promise<BulkPlannedStillRecord> {
    if (isTauri()) return invoke("suggest_still_prompt", { videoId, groupId, styleDirective, baseSettingsJson });
    throw new Error("Prompt suggestion requires the native application.");
  },
  /** Plans AND persists ONE batch of stills, starting at `startIndex` into
   * `selectedGroupIds` (scene-then-ordinal order — the caller's selection,
   * not necessarily the whole workspace). A single AI call never spans two
   * scenes, so the actual batch size is however many stills the scene at
   * `startIndex` has (capped for prompt size) — call repeatedly (advancing
   * `startIndex` by `plannedCount` each time) until `done`, checking a
   * pause/stop flag between calls, to drive a full pausable/resumable run.
   * Every batch is committed to the database the moment it lands — there's
   * no separate "approve" step, and progress survives a pause or the app
   * closing. */
  async planBulkVisualsBatch(
    videoId: string, styleDirective: string, baseSettingsJson: string, creativeInstruction: string,
    selectedGroupIds: string[], startIndex: number,
  ): Promise<BulkPlanBatchResultRecord> {
    if (isTauri()) return invoke("plan_bulk_visuals_batch", { videoId, styleDirective, baseSettingsJson, creativeInstruction, selectedGroupIds, startIndex });
    throw new Error("Bulk planning requires the native application.");
  },
  /** Runs the fully backend-owned "Auto motion" pass on the next batch of
   * not-yet-analyzed clips (composes, renders, and validates a motion
   * treatment for each — no client-side settings or feedback, the engine
   * decides everything on its own). Call repeatedly until `done`, checking
   * a pause/stop flag between calls — already-analyzed clips are skipped
   * automatically, so resuming never redoes completed work. */
  async analyzeMotionGraphicsBatch(videoId: string): Promise<MotionGraphicsBatchResultRecord> {
    if (isTauri()) return invoke("analyze_motion_graphics_batch", { videoId });
    throw new Error("Motion graphics analysis requires the native application.");
  },
  async applyStyleDirectiveToAll(videoId: string, styleDirective: string): Promise<number> {
    if (isTauri()) return invoke("apply_style_directive_to_all", { videoId, styleDirective });
    throw new Error("Style directive update requires the native application.");
  },
  async applyCreativeInstructionsToAll(videoId: string, creativeInstruction: string): Promise<number> {
    if (isTauri()) return invoke("apply_creative_instructions_to_all", { videoId, creativeInstruction });
    throw new Error("Creative instruction apply requires the native application.");
  },
  async importBrowserAsset(videoId: string, kind: "audio" | "reference", file: File) {
    if (isTauri()) throw new Error("Browser-file import is only available in the web preview.");
    const data = readBrowserData();
    const existing = await this.getVideoInputs(videoId);
    const asset: InputAssetRecord = {
      id: crypto.randomUUID(),
      videoId,
      kind,
      originalName: file.name,
      relativePath: `browser-preview/${file.name}`,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      createdAt: now(),
    };
    const inputs = kind === "audio"
      ? { ...existing, audio: asset, updatedAt: now() }
      : { ...existing, references: [...existing.references, asset], updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return asset;
  },
  async removeInputAsset(assetId: string) {
    if (isTauri()) return invoke<void>("remove_input_asset", { assetId });
  },
  async pickScriptText() {
    if (isTauri()) return invoke<string | null>("pick_script_text");
    return null;
  },
  async pickThumbnailImage(): Promise<{ dataUrl: string; fileName: string } | null> {
    if (isTauri()) return invoke("pick_thumbnail_image");
    return null;
  },
  async editThumbnailImage(sourceDataUrl: string, instruction: string, maskDataUrl: string | null, editStrength: string, aspectRatio: string): Promise<string> {
    if (isTauri()) return invoke("edit_thumbnail_image", { sourceDataUrl, instruction, maskDataUrl: maskDataUrl || null, editStrength, aspectRatio });
    throw new Error("Thumbnail editing requires the native application.");
  },
  async saveThumbnailImage(dataUrl: string, defaultName: string): Promise<string | null> {
    if (isTauri()) return invoke("save_thumbnail_image", { dataUrl, defaultName });
    return null;
  },
  async readBrowserScript(file: File) {
    if (file.size > 1_000_000) throw new Error("Script exceeds the 1 MB limit.");
    return file.text();
  },
  async generateVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("generate_visual_plan", { videoId });
    const inputs = await this.getVideoInputs(videoId);
    const cleanedScript = inputs.scriptText
      .replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const texts = cleanedScript.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((text) => text.trim()) ?? [];
    let cursor = 0;
    const sentences = texts.map((text, index) => {
      const duration = Math.max(1, text.split(/\s+/).length * 0.4);
      const sentence = { id: `s${index + 1}`, ordinal: index + 1, text, startSeconds: cursor, endSeconds: cursor + duration };
      cursor += duration; return sentence;
    });
    const groups: PlanGroupRecord[] = sentences.map((sentence, index) => ({ id: `g${index + 1}`, ordinal: index + 1, label: `Scene ${index + 1}`, kind: index ? "subject" : "establishing", sentenceIds: [sentence.id], settingsLocked: false, promptLocked: false, sceneId: null }));
    // Web-demo stand-in for the real engine's AI scene segmentation: chunks
    // every few stills into one scene, same crude fidelity as the Rust
    // test-fixture path (build_scenes_range) — no AI context fields, since
    // this mode never calls the AI at all.
    const scenes: PlanSceneRecord[] = [];
    for (let index = 0; index < groups.length; index += 3) {
      const chunk = groups.slice(index, index + 3);
      const ordinal = scenes.length + 1;
      const sceneId = `sc${ordinal}`;
      scenes.push({
        id: sceneId, ordinal, label: `Scene ${ordinal}`,
        narrativeRole: null, coreIdea: null, emotionalState: null,
        visualOpportunities: [], sentenceIds: chunk.flatMap((group) => group.sentenceIds),
        expanded: true,
      });
      chunk.forEach((group) => { group.sceneId = sceneId; });
    }
    const plan = { videoId, timingSource: "estimated", sentences, groups, scenes, updatedAt: now() };
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    localStorage.setItem(`${STORAGE_KEY}.plan.original.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async getVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("get_visual_plan", { videoId });
    const stored = localStorage.getItem(`${STORAGE_KEY}.plan.${videoId}`);
    if (!stored) throw new Error("Visual plan has not been generated.");
    return JSON.parse(stored) as VisualPlanRecord;
  },
  async movePlanSentence(videoId: string, sentenceId: string, targetGroupId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("move_plan_sentence", { videoId, sentenceId, targetGroupId });
    const plan = await this.getVisualPlan(videoId);
    const source = plan.groups.findIndex((group) => group.sentenceIds.includes(sentenceId));
    const target = plan.groups.findIndex((group) => group.id === targetGroupId);
    if (Math.abs(source - target) > 1) throw new Error("Sentences may only move to an adjacent scene.");
    plan.groups[source].sentenceIds = plan.groups[source].sentenceIds.filter((id) => id !== sentenceId);
    plan.groups[target].sentenceIds.push(sentenceId);
    plan.groups = plan.groups.filter((group) => group.sentenceIds.length);
    assignSceneIds(plan.groups, plan.scenes);
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async createPlanGroup(videoId: string, sentenceId: string, insertIndex: number, keepInCurrentScene: boolean): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("create_plan_group", { videoId, sentenceId, insertIndex, keepInCurrentScene });
    const plan = await this.getVisualPlan(videoId);
    const source = plan.groups.findIndex((group) => group.sentenceIds.includes(sentenceId));
    if (source < 0) throw new Error("Sentence was not found.");
    plan.groups[source].sentenceIds = plan.groups[source].sentenceIds.filter((id) => id !== sentenceId);
    plan.groups = plan.groups.filter((group) => group.sentenceIds.length);
    plan.groups.splice(Math.min(insertIndex, plan.groups.length), 0, {
      id: crypto.randomUUID(), ordinal: 0, label: "New still", kind: "custom", sentenceIds: [sentenceId], settingsLocked: false, promptLocked: false, sceneId: null,
    });
    plan.groups.sort((a, b) => Number(a.sentenceIds[0].slice(1)) - Number(b.sentenceIds[0].slice(1)));
    plan.groups.forEach((group, index) => { group.ordinal = index + 1; });
    // This browser/dev fallback never had the Tauri backend's "peel into a
    // brand new scene at a seam" behavior at all — it never auto-created a
    // scene here, so it already matches keepInCurrentScene=true unconditionally;
    // keepInCurrentScene is a no-op parameter in this fallback.
    assignSceneIds(plan.groups, plan.scenes);
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async resetVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("reset_visual_plan", { videoId });
    const original = localStorage.getItem(`${STORAGE_KEY}.plan.original.${videoId}`);
    if (!original) throw new Error("Original visual plan was not found.");
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, original);
    return JSON.parse(original) as VisualPlanRecord;
  },
  /** The backend half of the Visual Plan tab's undo/redo (mirrors
   * restoreTimelineSnapshot) — the frontend keeps its own in-memory stack
   * of whole VisualPlanRecord snapshots from before each edit and hands
   * one straight back here to undo/redo it. Independent of "Reset
   * original" (resetVisualPlan), which always targets the fixed
   * generation-time snapshot, not this session's edit history. */
  async restoreVisualPlanSnapshot(videoId: string, snapshot: VisualPlanRecord): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("restore_visual_plan_snapshot", { videoId, snapshotJson: JSON.stringify(snapshot) });
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(snapshot));
    return snapshot;
  },
  async setPlanSceneExpanded(videoId: string, sceneId: string, expanded: boolean): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("set_plan_scene_expanded", { videoId, sceneId, expanded });
    const plan = await this.getVisualPlan(videoId);
    const scene = plan.scenes.find((item) => item.id === sceneId);
    if (!scene) throw new Error("Scene was not found.");
    scene.expanded = expanded;
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async getBulkSceneSettings(videoId: string): Promise<BulkSceneSettingsRecord[]> {
    if (isTauri()) return invoke("get_bulk_scene_settings", { videoId });
    const raw = localStorage.getItem(`${STORAGE_KEY}.bulkSceneSettings.${videoId}`);
    return raw ? (JSON.parse(raw) as BulkSceneSettingsRecord[]) : [];
  },
  /** Upserts one scene's full override state — always send every field
   * (null clears that field back to "inherit"), mirroring how the panel
   * always holds the complete current override record in memory. */
  async saveBulkSceneSettings(
    videoId: string, sceneId: string,
    styleDirective: string | null, creativeInstruction: string | null,
    dials: BulkVisualDialsRecord,
  ): Promise<BulkSceneSettingsRecord> {
    if (isTauri()) {
      return invoke("save_bulk_scene_settings", { videoId, sceneId, styleDirective, creativeInstruction, dials });
    }
    const key = `${STORAGE_KEY}.bulkSceneSettings.${videoId}`;
    const all = await this.getBulkSceneSettings(videoId);
    const record: BulkSceneSettingsRecord = { sceneId, styleDirective, creativeInstruction, dials };
    const next = [...all.filter((item) => item.sceneId !== sceneId), record];
    localStorage.setItem(key, JSON.stringify(next));
    return record;
  },
  async getBulkGlobalSettings(videoId: string): Promise<BulkGlobalVisualSettingsRecord> {
    if (isTauri()) return invoke("get_bulk_global_settings", { videoId });
    const raw = localStorage.getItem(`${STORAGE_KEY}.bulkGlobalSettings.${videoId}`);
    return raw ? (JSON.parse(raw) as BulkGlobalVisualSettingsRecord) : emptyBulkGlobalVisualSettings();
  },
  async saveBulkGlobalSettings(
    videoId: string, dials: BulkVisualDialsRecord,
    visualizationTypes: string[], visualizationHardRule: boolean,
  ): Promise<BulkGlobalVisualSettingsRecord> {
    if (isTauri()) return invoke("save_bulk_global_settings", { videoId, dials, visualizationTypes, visualizationHardRule });
    const record: BulkGlobalVisualSettingsRecord = { dials, visualizationTypes, visualizationHardRule };
    localStorage.setItem(`${STORAGE_KEY}.bulkGlobalSettings.${videoId}`, JSON.stringify(record));
    return record;
  },
  async getBulkStillSettings(videoId: string): Promise<BulkStillSettingsRecord[]> {
    if (isTauri()) return invoke("get_bulk_still_settings", { videoId });
    const raw = localStorage.getItem(`${STORAGE_KEY}.bulkStillSettings.${videoId}`);
    return raw ? (JSON.parse(raw) as BulkStillSettingsRecord[]) : [];
  },
  /** Applies one Visualization Type choice to every still in `groupIds` at
   * once (the Bulk Generation panel's "apply to current selection"
   * control) — `visualizationType: null` resets those stills back to
   * "Auto"/inherit. Returns the video's full updated list. */
  async saveBulkStillVisualizationTypes(
    videoId: string, groupIds: string[], visualizationType: string | null,
  ): Promise<BulkStillSettingsRecord[]> {
    if (isTauri()) return invoke("save_bulk_still_visualization_types", { videoId, groupIds, visualizationType });
    const key = `${STORAGE_KEY}.bulkStillSettings.${videoId}`;
    const all = await this.getBulkStillSettings(videoId);
    const groupIdSet = new Set(groupIds);
    const kept = all.filter((item) => !groupIdSet.has(item.groupId));
    const next = visualizationType ? [...kept, ...groupIds.map((groupId) => ({ groupId, visualizationType }))] : kept;
    localStorage.setItem(key, JSON.stringify(next));
    return next;
  },
  // Character/location roster — replaces the old single global/scene
  // reference model. No browser/dev localStorage fallback for these (the
  // roster + cast-assignment feature is Tauri-only, same as several other
  // AI-backed bulk-generation features already are); calling these outside
  // Tauri throws, matching how e.g. suggestImagePrompt already behaves.
  async listRosterCharacters(videoId: string): Promise<RosterCharacterRecord[]> {
    return invoke("list_roster_characters", { videoId });
  },
  async createRosterCharacter(videoId: string, name: string): Promise<RosterCharacterRecord> {
    return invoke("create_roster_character", { videoId, name });
  },
  async renameRosterCharacter(characterId: string, name: string): Promise<RosterCharacterRecord> {
    return invoke("rename_roster_character", { characterId, name });
  },
  async setRosterCharacterReference(characterId: string, assetId: string | null): Promise<RosterCharacterRecord> {
    return invoke("set_roster_character_reference", { characterId, assetId });
  },
  async deleteRosterCharacter(characterId: string): Promise<void> {
    return invoke("delete_roster_character", { characterId });
  },
  async listRosterLocations(videoId: string): Promise<RosterLocationRecord[]> {
    return invoke("list_roster_locations", { videoId });
  },
  async createRosterLocation(videoId: string, name: string): Promise<RosterLocationRecord> {
    return invoke("create_roster_location", { videoId, name });
  },
  async renameRosterLocation(locationId: string, name: string): Promise<RosterLocationRecord> {
    return invoke("rename_roster_location", { locationId, name });
  },
  async setRosterLocationReference(locationId: string, assetId: string | null): Promise<RosterLocationRecord> {
    return invoke("set_roster_location_reference", { locationId, assetId });
  },
  async deleteRosterLocation(locationId: string): Promise<void> {
    return invoke("delete_roster_location", { locationId });
  },
  async getSceneCastAssignments(videoId: string): Promise<SceneCastAssignmentRecord[]> {
    return invoke("get_scene_cast_assignments", { videoId });
  },
  async saveSceneCastAssignment(
    videoId: string, sceneId: string, assignedCharacterIds: string[], assignedLocationId: string | null,
  ): Promise<SceneCastAssignmentRecord> {
    return invoke("save_scene_cast_assignment", { videoId, sceneId, assignedCharacterIds, assignedLocationId });
  },
  async suggestSceneCastBatch(videoId: string, sceneIds: string[]): Promise<SceneCastAssignmentRecord[]> {
    return invoke("suggest_scene_cast_batch", { videoId, sceneIds });
  },
  async listExtractableStyleAspects(): Promise<StyleAspectRecord[]> {
    return invoke("list_extractable_style_aspects", {});
  },
  async updatePlanSentenceText(videoId: string, sentenceId: string, text: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("update_plan_sentence_text", { videoId, sentenceId, text });
    const plan = await this.getVisualPlan(videoId);
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Sentence text is required.");
    plan.sentences = plan.sentences.map((s) => (s.id === sentenceId ? { ...s, text: trimmed } : s));
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async splitPlanSentence(videoId: string, sentenceId: string, leftText: string, rightText: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("split_plan_sentence", { videoId, sentenceId, leftText, rightText });
    const plan = await this.getVisualPlan(videoId);
    const targetNumber = Number(sentenceId.slice(1));
    const target = plan.sentences.find((s) => s.id === sentenceId);
    if (!target) throw new Error("Sentence was not found.");
    leftText = leftText.trim();
    rightText = rightText.trim();
    if (!leftText || !rightText) throw new Error("Split point must have text on both sides.");
    const leftWords = Math.max(1, leftText.split(/\s+/).length);
    const rightWords = Math.max(1, rightText.split(/\s+/).length);
    const fraction = leftWords / (leftWords + rightWords);
    const midpoint = target.startSeconds + (target.endSeconds - target.startSeconds) * fraction;
    const newRightId = `s${targetNumber + 1}`;
    const renumber = (id: string): string[] => {
      const n = Number(id.slice(1));
      if (n === targetNumber) return [`s${n}`, newRightId];
      if (n > targetNumber) return [`s${n + 1}`];
      return [id];
    };
    plan.sentences = plan.sentences.flatMap((s) => {
      if (s.id !== sentenceId) {
        const n = Number(s.id.slice(1));
        return [{ ...s, id: n > targetNumber ? `s${n + 1}` : s.id }];
      }
      return [
        { ...s, text: leftText, endSeconds: midpoint },
        { id: newRightId, ordinal: 0, text: rightText, startSeconds: midpoint, endSeconds: target.endSeconds },
      ];
    }).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
      .map((s, index) => ({ ...s, ordinal: index + 1 }));
    plan.groups = plan.groups.map((group) => ({ ...group, sentenceIds: group.sentenceIds.flatMap(renumber) }))
      .filter((group) => group.sentenceIds.length)
      .map((group, index) => ({ ...group, ordinal: index + 1 }));
    plan.scenes = renumberSceneSentenceIds(plan.scenes, renumber);
    assignSceneIds(plan.groups, plan.scenes);
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async mergePlanSentences(videoId: string, firstSentenceId: string, secondSentenceId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("merge_plan_sentences", { videoId, firstSentenceId, secondSentenceId });
    const plan = await this.getVisualPlan(videoId);
    const firstNumber = Number(firstSentenceId.slice(1));
    const secondNumber = Number(secondSentenceId.slice(1));
    if (secondNumber !== firstNumber + 1) throw new Error("Only chronologically adjacent sentences can be merged.");
    const first = plan.sentences.find((s) => s.id === firstSentenceId);
    const second = plan.sentences.find((s) => s.id === secondSentenceId);
    if (!first || !second) throw new Error("Sentence was not found.");
    const renumber = (id: string): string[] => {
      const n = Number(id.slice(1));
      if (n === secondNumber) return [];
      if (n > secondNumber) return [`s${n - 1}`];
      return [id];
    };
    plan.sentences = plan.sentences
      .filter((s) => s.id !== secondSentenceId)
      .map((s) => {
        if (s.id !== firstSentenceId) {
          const n = Number(s.id.slice(1));
          return { ...s, id: n > secondNumber ? `s${n - 1}` : s.id };
        }
        // Strip the trailing period at the join so the merge is reversible
        // the same way it was created: typing "." back at that spot
        // re-triggers the auto-split.
        const firstTrimmed = first.text.trim();
        const firstJoined = firstTrimmed.endsWith(".") ? firstTrimmed.slice(0, -1) : firstTrimmed;
        return {
          ...s,
          text: `${firstJoined} ${second.text.trim()}`,
          startSeconds: Math.min(first.startSeconds, second.startSeconds),
          endSeconds: Math.max(first.endSeconds, second.endSeconds),
        };
      })
      .map((s, index) => ({ ...s, ordinal: index + 1 }));
    plan.groups = plan.groups.map((group) => ({ ...group, sentenceIds: group.sentenceIds.flatMap(renumber) }))
      .filter((group) => group.sentenceIds.length)
      .map((group, index) => ({ ...group, ordinal: index + 1 }));
    plan.scenes = renumberSceneSentenceIds(plan.scenes, renumber);
    assignSceneIds(plan.groups, plan.scenes);
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async generateCaptions(videoId: string, intervalSeconds: number): Promise<CaptionSetRecord> {
    if (isTauri()) return invoke("generate_captions", { videoId, intervalSeconds });
    const inputs = await this.getVideoInputs(videoId);
    const cleanedScript = inputs.scriptText
      .replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = cleanedScript.split(" ").filter(Boolean);
    const chunks: CaptionChunkRecord[] = [];
    for (let i = 0; i < words.length; i += 3) {
      const group = words.slice(i, i + 3);
      const index = chunks.length + 1;
      chunks.push({ index, text: group.join(" "), startSeconds: chunks.length, endSeconds: chunks.length + 1, words: [] });
    }
    const srtText = chunks
      .map((c) => `${c.index}\n${formatSrtTimestamp(c.startSeconds)} --> ${formatSrtTimestamp(c.endSeconds)}\n${c.text}\n`)
      .join("\n");
    const set: CaptionSetRecord = { videoId, intervalSeconds, srtText, chunks, generatedAt: now(), updatedAt: now() };
    localStorage.setItem(`${STORAGE_KEY}.captions.${videoId}`, JSON.stringify(set));
    return set;
  },
  async getCaptions(videoId: string): Promise<CaptionSetRecord> {
    if (isTauri()) return invoke("get_captions", { videoId });
    const stored = localStorage.getItem(`${STORAGE_KEY}.captions.${videoId}`);
    if (!stored) throw new Error("Captions have not been generated.");
    return JSON.parse(stored) as CaptionSetRecord;
  },
  async saveCaptionsFile(srtText: string, defaultName: string): Promise<string | null> {
    if (isTauri()) return invoke("save_captions_file", { srtText, defaultName });
    const blob = new Blob([srtText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = defaultName;
    link.click();
    URL.revokeObjectURL(url);
    return null;
  },
};

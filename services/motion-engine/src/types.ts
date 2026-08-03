// Canonical effect names — MUST stay byte-identical to:
//   apps/desktop/src-tauri/src/projects.rs -> MOTION_GRAPHIC_EFFECTS
//   apps/desktop/src/timeline/motion-graphics.ts -> MOTION_GRAPHIC_EFFECTS
//   services/python-engine/auto_gen_engine/motion_graphics_engine.py -> Effect literal
// This is the one place all three languages' string-literal lists are meant
// to agree with; if you add/rename an effect, update all four.
export type EffectName =
  | "Ken Burns"
  | "Sequential Panel Reveal"
  | "Speed Pan & Motion Blur"
  | "Ominous Push-In"
  | "Candlelight Flicker"
  | "Focus Pull"
  | "Iris Reveal";

export interface PanelRect {
  x: number; // fraction of image width, 0-1
  y: number; // fraction of image height, 0-1
  w: number; // fraction of image width, 0-1
  h: number; // fraction of image height, 0-1
}

export interface KenBurnsSettings {
  scaleFrom: number;
  scaleTo: number;
  panX: number; // percent, e.g. -4 to 4
  panY: number; // percent, e.g. -3 to 3
}

export interface SequentialPanelRevealSettings {
  holdStartFrames: number;
  cropPadding: number;
  // Fractional bounding boxes of each sub-panel, reading order. Optional for
  // backward compatibility with rows saved before this field existed — the
  // component falls back to a single Ken-Burns-style push over the whole
  // image when absent/empty rather than throwing.
  panels?: PanelRect[];
}

export interface SpeedPanSettings {
  scaleFrom: number;
  scaleTo: number;
  panXFrom: number; // percent
  panXTo: number; // percent — sign encodes direction
}

export interface OminousPushInSettings {
  scaleFrom: number;
  scaleTo: number;
  transformOriginX: number; // percent, 0-100
  transformOriginY: number; // percent, 0-100
  glowColor: string; // css rgba string
}

export interface CandlelightFlickerSettings {
  glowX: number; // fraction, 0-1
  glowY: number; // fraction, 0-1
  scaleFrom: number;
  scaleTo: number;
  transformOriginX: number; // percent, 0-100
  transformOriginY: number; // percent, 0-100
  flickerAmplitude: number; // ~0.1-0.2
}

export interface FocusPullSettings {
  transformOriginX: number; // percent, 0-100 — subject position
  transformOriginY: number; // percent, 0-100
  startBlurPx: number; // background blur at the start of the rack focus
  endBlurPx: number; // background blur at the end (usually ~0, sharp)
  maskRadius: number; // fraction of frame diagonal covered by the sharp circle, ~0.2-0.45
  scaleFrom: number;
  scaleTo: number;
}

export interface IrisRevealSettings {
  revealX: number; // fraction, 0-1 — center of the iris
  revealY: number; // fraction, 0-1
  startRadius: number; // fraction of frame diagonal, ~0-0.05
  endRadius: number; // fraction of frame diagonal, ~0.75-1.0 (fully open)
  holdBeforeFrames: number; // frames held closed before the reveal starts
  scaleFrom: number;
  scaleTo: number;
}

export type EffectSettingsMap = {
  "Ken Burns": KenBurnsSettings;
  "Sequential Panel Reveal": SequentialPanelRevealSettings;
  "Speed Pan & Motion Blur": SpeedPanSettings;
  "Ominous Push-In": OminousPushInSettings;
  "Candlelight Flicker": CandlelightFlickerSettings;
  "Focus Pull": FocusPullSettings;
  "Iris Reveal": IrisRevealSettings;
};

export interface MotionClipProps {
  imagePath: string;
  effect: EffectName;
  settings: EffectSettingsMap[EffectName];
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}

export const DEFAULT_PROPS: MotionClipProps = {
  imagePath: "",
  effect: "Ken Burns",
  settings: { scaleFrom: 1.08, scaleTo: 1.28, panX: -4, panY: 2 },
  durationInFrames: 150,
  fps: 30,
  width: 1920,
  height: 1080,
};

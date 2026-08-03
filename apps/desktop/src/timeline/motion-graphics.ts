import type { MotionGraphicEffect } from "../infrastructure/projects-client";

/** One tunable field of a motion graphic effect's settings JSON. Drives a
 * generic settings form (range slider or select) in ClipInspector, rather
 * than needing 5 bespoke per-effect components. */
export type MotionGraphicField =
  | { key: string; label: string; type: "range"; min: number; max: number; step: number }
  | { key: string; label: string; type: "select"; options: string[] };

export type MotionGraphicEffectDef = {
  id: MotionGraphicEffect;
  label: string;
  /** "What it does" — from SOPs/Motion_Graphics_SOP_v1.md §5. */
  summary: string;
  /** "Best for" — from SOP §5/§6's decision matrix. */
  bestFor: string;
  fields: MotionGraphicField[];
  defaults: Record<string, number | string>;
};

/** Registry of the 7 treatments documented in SOPs/Motion_Graphics_SOP_v1.md.
 * Rendered for real at export time by services/motion-engine's `MotionClip`
 * composition (see video_export_engine.py's `_render_motion_graphic`) — see
 * the Rust MOTION_GRAPHIC_EFFECTS const's doc comment for how the settings
 * saved here flow all the way through to the exported video. */
export const MOTION_GRAPHIC_EFFECTS: MotionGraphicEffectDef[] = [
  {
    id: "Ken Burns",
    label: "Ken Burns",
    summary: "Classic documentary push-in combined with a diagonal pan.",
    bestFor: "Dialogue scenes, two-subject compositions, any shot with clear foreground/background separation and calm/expository narration.",
    fields: [
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.0, max: 1.3, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.1, max: 1.6, step: 0.01 },
      { key: "panX", label: "Pan X (%)", type: "range", min: -10, max: 10, step: 0.5 },
      { key: "panY", label: "Pan Y (%)", type: "range", min: -10, max: 10, step: 0.5 },
    ],
    defaults: { scaleFrom: 1.08, scaleTo: 1.28, panX: -4, panY: 2 },
  },
  {
    id: "Sequential Panel Reveal",
    label: "Sequential Panel Reveal",
    summary: "Snap-zooms between sub-panels of a single grid/contact-sheet image, in reading order.",
    bestFor: "Recap grids, contact-sheet style frames — only fits an image that is itself a grid of smaller scenes.",
    fields: [
      { key: "holdStartFrames", label: "Hold start (frames)", type: "range", min: 5, max: 40, step: 1 },
      { key: "cropPadding", label: "Crop padding", type: "range", min: 1.0, max: 1.3, step: 0.01 },
    ],
    defaults: { holdStartFrames: 20, cropPadding: 1.12 },
  },
  {
    id: "Speed Pan & Motion Blur",
    label: "Speed Pan & Motion Blur",
    summary: "Fast horizontal drift with velocity-linked directional blur and ghost trails.",
    bestFor: "Riders, runners, marching columns — anything with an implied direction of travel.",
    fields: [
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.05, max: 1.3, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.15, max: 1.5, step: 0.01 },
      { key: "panXFrom", label: "Pan X from (%)", type: "range", min: -15, max: 15, step: 0.5 },
      { key: "panXTo", label: "Pan X to (%)", type: "range", min: -15, max: 15, step: 0.5 },
    ],
    defaults: { scaleFrom: 1.18, scaleTo: 1.34, panXFrom: 6, panXTo: -10 },
  },
  {
    id: "Ominous Push-In",
    label: "Ominous Push-In",
    summary: "Slow, steady push-in with progressive desaturation and a pulsing warm/red glow.",
    bestFor: "Close-up portraits, masked/hooded/obscured figures, any single-subject frame meant to feel unsettling or significant.",
    fields: [
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.05, max: 1.25, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.25, max: 1.55, step: 0.01 },
      { key: "transformOriginX", label: "Face position X (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "transformOriginY", label: "Face position Y (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "glowColor", label: "Glow color", type: "select", options: ["rgba(196,84,79,0.55)", "rgba(120,90,200,0.5)", "rgba(80,150,200,0.5)", "rgba(200,160,60,0.5)"] },
    ],
    defaults: { scaleFrom: 1.15, scaleTo: 1.42, transformOriginX: 50, transformOriginY: 38, glowColor: "rgba(196,84,79,0.55)" },
  },
  {
    id: "Candlelight Flicker",
    label: "Candlelight Flicker",
    summary: "Near-static framing with an organic warm-light flicker anchored at a fixed point.",
    bestFor: "Interior frames with a visible candle/torch/fire — the flicker should read as motivated by a real light source.",
    fields: [
      { key: "glowX", label: "Glow X (0-1)", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "glowY", label: "Glow Y (0-1)", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.0, max: 1.1, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.05, max: 1.25, step: 0.01 },
      { key: "transformOriginX", label: "Origin X (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "transformOriginY", label: "Origin Y (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "flickerAmplitude", label: "Flicker amplitude", type: "range", min: 0.05, max: 0.3, step: 0.01 },
    ],
    defaults: { glowX: 0.935, glowY: 0.1, scaleFrom: 1.05, scaleTo: 1.16, transformOriginX: 62, transformOriginY: 55, flickerAmplitude: 0.15 },
  },
  {
    id: "Focus Pull",
    label: "Focus Pull",
    summary: "A blurred wide view racks into sharp focus on the subject — depth-of-field push, no cutout needed.",
    bestFor: "A moment of realization, a detail the narration calls out, introducing a specific character/object within a busier scene.",
    fields: [
      { key: "transformOriginX", label: "Subject position X (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "transformOriginY", label: "Subject position Y (%)", type: "range", min: 0, max: 100, step: 1 },
      { key: "startBlurPx", label: "Start blur (px)", type: "range", min: 4, max: 24, step: 1 },
      { key: "endBlurPx", label: "End blur (px)", type: "range", min: 0, max: 6, step: 0.5 },
      { key: "maskRadius", label: "Sharp-circle radius", type: "range", min: 0.15, max: 0.5, step: 0.01 },
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.0, max: 1.1, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.05, max: 1.2, step: 0.01 },
    ],
    defaults: { transformOriginX: 50, transformOriginY: 50, startBlurPx: 14, endBlurPx: 0, maskRadius: 0.3, scaleFrom: 1.05, scaleTo: 1.14 },
  },
  {
    id: "Iris Reveal",
    label: "Iris Reveal",
    summary: "A circular wipe opens over the subject, revealing the frame from a point outward.",
    bestFor: "An unveiling/presentation beat, a dramatic entrance, a reveal the narration is building toward — not a neutral default choice.",
    fields: [
      { key: "revealX", label: "Reveal X (0-1)", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "revealY", label: "Reveal Y (0-1)", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "startRadius", label: "Start radius", type: "range", min: 0, max: 0.1, step: 0.005 },
      { key: "endRadius", label: "End radius", type: "range", min: 0.5, max: 1.0, step: 0.01 },
      { key: "holdBeforeFrames", label: "Hold before (frames)", type: "range", min: 0, max: 30, step: 1 },
      { key: "scaleFrom", label: "Scale from", type: "range", min: 1.0, max: 1.1, step: 0.01 },
      { key: "scaleTo", label: "Scale to", type: "range", min: 1.02, max: 1.2, step: 0.01 },
    ],
    defaults: { revealX: 0.5, revealY: 0.5, startRadius: 0.02, endRadius: 0.9, holdBeforeFrames: 8, scaleFrom: 1.02, scaleTo: 1.08 },
  },
];

export function getMotionGraphicEffectDef(effect: string | null | undefined): MotionGraphicEffectDef | undefined {
  return MOTION_GRAPHIC_EFFECTS.find((def) => def.id === effect);
}

export function parseMotionGraphicSettings(settingsJson: string | null | undefined): Record<string, number | string> {
  if (!settingsJson) return {};
  try {
    const parsed = JSON.parse(settingsJson);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

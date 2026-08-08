import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION_RECIPE, type MotionRecipe } from "../infrastructure/projects-client";
import { applyMotionRecipe } from "./timeline-rendering";

// Root-cause coverage for "Motion panel changes aren't visible in the
// preview": the canvas used to read a separate motionPreset/motionIntensity
// pair that a manual settings edit never touched at all (motionIntensity in
// particular was never written by set_timeline_clip_motion_graphic), so an
// intensity-slider drag or a depth/story/environment change produced zero
// visible difference. applyMotionRecipe reads the recipe's own continuous
// fields directly instead — these tests pin down that every dial that
// matters actually moves the returned rect/blur.
describe("applyMotionRecipe", () => {
  const BASE_RECT = { x: 0, y: 0, w: 1000, h: 1000 };
  const CANVAS_W = 1000;
  const CANVAS_H = 1000;

  it("interpolates scale linearly across the clip's duration (default 'ease' behaves like the midpoint of a smoothstep)", () => {
    const recipe: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, cameraEffect: "zoom_in", scaleFrom: 1.0, scaleTo: 1.2, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0, easing: "linear" };
    const start = applyMotionRecipe(recipe, 0, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    const mid = applyMotionRecipe(recipe, 5, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    const end = applyMotionRecipe(recipe, 10, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    expect(start.w).toBeCloseTo(BASE_RECT.w * 1.0);
    expect(end.w).toBeCloseTo(BASE_RECT.w * 1.2);
    expect(mid.w).toBeCloseTo(BASE_RECT.w * 1.1, 1);
    expect(mid.w).toBeGreaterThan(start.w);
    expect(mid.w).toBeLessThan(end.w);
  });

  it("a larger intensity (bigger scale delta) produces a visibly larger rect at the same point in time — this is exactly what the intensity slider used to have zero effect on", () => {
    const subtle: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, scaleFrom: 1.0, scaleTo: 1.05, panXFrom: 0, panXTo: 0, panYFrom: 0, panYTo: 0, easing: "linear" };
    const strong: MotionRecipe = { ...subtle, scaleTo: 1.4 };
    const subtleResult = applyMotionRecipe(subtle, 5, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    const strongResult = applyMotionRecipe(strong, 5, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    expect(strongResult.w).toBeGreaterThan(subtleResult.w);
  });

  it("pans in the recipe's percent-of-frame units, anchored at the recipe's own origin", () => {
    const recipe: MotionRecipe = {
      ...DEFAULT_MOTION_RECIPE,
      scaleFrom: 1, scaleTo: 1,
      panXFrom: 0, panXTo: 10, panYFrom: 0, panYTo: 0,
      originX: 50, originY: 50,
      easing: "linear",
    };
    const end = applyMotionRecipe(recipe, 10, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    // panXTo=10 means 10% of the canvas width (1000px) = 100px translation,
    // with scale=1 so no scale-driven offset on top of it.
    expect(end.x).toBeCloseTo(BASE_RECT.x + 100, 0);
    expect(end.y).toBeCloseTo(BASE_RECT.y, 0);
  });

  it("switching camera effect (different pan/scale shape) changes the rect even at a fixed point in time — dropdown changes are no longer bucketed into indistinguishable presets", () => {
    const pushIn: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, scaleFrom: 1.0, scaleTo: 1.12, panXFrom: 0, panXTo: 1.5, panYFrom: 0, panYTo: 0, easing: "linear" };
    const positionPan: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, scaleFrom: 1.03, scaleTo: 1.03, panXFrom: -4, panXTo: 4, panYFrom: 0, panYTo: 0, easing: "linear" };
    const pushInResult = applyMotionRecipe(pushIn, 5, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    const panResult = applyMotionRecipe(positionPan, 5, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    expect(pushInResult.x).not.toBeCloseTo(panResult.x, 0);
    expect(pushInResult.w).not.toBeCloseTo(panResult.w, 0);
  });

  it("focus_shift blurs progressively; every other depth effect (no whole-frame blur primitive to approximate) reports zero blur in preview", () => {
    const focusShift: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, depthEffect: "focus_shift", blurFromPx: 0, blurToPx: 8, easing: "linear" };
    const start = applyMotionRecipe(focusShift, 0, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    const end = applyMotionRecipe(focusShift, 10, 10, BASE_RECT, CANVAS_W, CANVAS_H);
    expect(start.blurPx).toBeCloseTo(0);
    expect(end.blurPx).toBeCloseTo(8);

    const parallax: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, depthEffect: "parallax_3d", bgBlurFromPx: 0, bgBlurToPx: 8 };
    expect(applyMotionRecipe(parallax, 10, 10, BASE_RECT, CANVAS_W, CANVAS_H).blurPx).toBe(0);

    const none: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, depthEffect: "none" };
    expect(applyMotionRecipe(none, 10, 10, BASE_RECT, CANVAS_W, CANVAS_H).blurPx).toBe(0);
  });

  it("a zero-duration clip doesn't divide by zero (falls back to progress 0)", () => {
    const recipe: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, scaleFrom: 1, scaleTo: 1.5 };
    const result = applyMotionRecipe(recipe, 0, 0, BASE_RECT, CANVAS_W, CANVAS_H);
    expect(Number.isFinite(result.w)).toBe(true);
    expect(result.w).toBeCloseTo(BASE_RECT.w);
  });
});

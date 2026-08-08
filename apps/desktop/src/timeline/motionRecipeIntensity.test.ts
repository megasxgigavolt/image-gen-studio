import { describe, expect, it } from "vitest";
import { DEFAULT_MOTION_RECIPE, type MotionRecipe } from "../infrastructure/projects-client";
import {
  applyCameraEffect,
  applyDepthEffect,
  applyEnvironmentEffect,
  applyIntensity,
  applyStoryEffect,
  deriveIntensityFromRecipe,
} from "./motionRecipeIntensity";

describe("applyIntensity / deriveIntensityFromRecipe round-trip", () => {
  it("round-trips a scale-dominant effect (zoom_in) through apply then derive", () => {
    const recipe = applyIntensity(DEFAULT_MOTION_RECIPE, "zoom_in", 40);
    expect(recipe.scaleFrom).toBe(1.0);
    expect(recipe.scaleTo).toBeGreaterThan(1.0);
    expect(deriveIntensityFromRecipe(recipe, "zoom_in")).toBe(40);
  });

  it("zoom_out shrinks scaleFrom toward scaleTo instead of growing scaleTo", () => {
    const recipe = applyIntensity(DEFAULT_MOTION_RECIPE, "zoom_out", 100);
    expect(recipe.scaleTo).toBe(1.0);
    expect(recipe.scaleFrom).toBeGreaterThan(1.0);
  });

  it("round-trips a pan-dominant effect (position_pan)", () => {
    const recipe = applyIntensity(DEFAULT_MOTION_RECIPE, "position_pan", 60);
    expect(Math.abs(recipe.panXTo - recipe.panXFrom)).toBeGreaterThan(0);
    expect(deriveIntensityFromRecipe(recipe, "position_pan")).toBe(60);
  });

  it("preserves an existing pan's direction/sign when re-applying a new intensity", () => {
    const leaning: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, panXFrom: 3, panXTo: -3 };
    const recipe = applyIntensity(leaning, "position_pan", 50);
    // Original delta was negative (panXTo < panXFrom) — the new magnitude
    // should be applied in the same direction, not flipped.
    expect(recipe.panXTo).toBeLessThan(recipe.panXFrom);
  });

  it("dynamic_reframing scales both scale and pan together, preserving pan direction", () => {
    const shaped: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, panXFrom: -2, panXTo: 6, panYFrom: 0, panYTo: 2 };
    const recipe = applyIntensity(shaped, "dynamic_reframing", 100);
    expect(Math.abs(recipe.scaleTo - recipe.scaleFrom)).toBeGreaterThan(0);
    expect(Math.hypot(recipe.panXTo - recipe.panXFrom, recipe.panYTo - recipe.panYFrom)).toBeGreaterThan(0);
    // x moved more than y originally — that ratio should roughly survive.
    expect(Math.abs(recipe.panXTo - recipe.panXFrom)).toBeGreaterThan(Math.abs(recipe.panYTo - recipe.panYFrom));
  });

  it("never multiplies the existing value — reapplying the same percent twice is idempotent", () => {
    const once = applyIntensity(DEFAULT_MOTION_RECIPE, "zoom_in", 50);
    const twice = applyIntensity(once, "zoom_in", 50);
    expect(twice.scaleTo).toBe(once.scaleTo);
  });

  it("covers camera_drift as a pan-dominant effect too", () => {
    const recipe = applyIntensity(DEFAULT_MOTION_RECIPE, "camera_drift", 30);
    expect(deriveIntensityFromRecipe(recipe, "camera_drift")).toBe(30);
  });
});

describe("applyCameraEffect", () => {
  it("re-seeds Tier-1 fields when switching effects, then reapplies the given intensity", () => {
    const zoomed = applyIntensity(DEFAULT_MOTION_RECIPE, "zoom_in", 80);
    const switched = applyCameraEffect(zoomed, "position_pan", 80);
    expect(switched.cameraEffect).toBe("position_pan");
    // Switching away from zoom should flatten scale back toward the new baseline,
    // not leave the old zoom_in scaleTo in place.
    expect(switched.scaleTo).toBeCloseTo(1.03, 5);
    expect(Math.abs(switched.panXTo - switched.panXFrom)).toBeGreaterThan(0);
  });
});

describe("tier neutralization/seeding", () => {
  it("applyDepthEffect zeroes fg/blur fields when set to none", () => {
    const active: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, depthEffect: "parallax_3d", fgScaleTo: 1.4, blurToPx: 12 };
    const neutralized = applyDepthEffect(active, "none");
    expect(neutralized.fgScaleTo).toBe(1);
    expect(neutralized.blurToPx).toBe(0);
  });

  it("applyDepthEffect seeds defaults when switching from none to an active option", () => {
    const neutral: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, depthEffect: "none", fgScaleFrom: 1, fgScaleTo: 1 };
    const seeded = applyDepthEffect(neutral, "parallax_3d");
    expect(seeded.depthEffect).toBe("parallax_3d");
    expect(seeded.fgScaleFrom).toBe(DEFAULT_MOTION_RECIPE.fgScaleFrom);
    expect(seeded.fgScaleTo).toBe(DEFAULT_MOTION_RECIPE.fgScaleTo);
  });

  it("applyStoryEffect clears mask/freeze/path fields when set to none", () => {
    const active: MotionRecipe = {
      ...DEFAULT_MOTION_RECIPE, storyEffect: "mask_reveal", maskShape: "circle", maskHoldFrames: 10,
    };
    const neutralized = applyStoryEffect(active, "none");
    expect(neutralized.maskShape).toBe("none");
    expect(neutralized.maskHoldFrames).toBe(0);
  });

  it("applyEnvironmentEffect zeroes intensity when set to none, seeds a default when activated", () => {
    const active: MotionRecipe = { ...DEFAULT_MOTION_RECIPE, environmentEffect: "fog", environmentIntensity: 0.6 };
    const neutralized = applyEnvironmentEffect(active, "none");
    expect(neutralized.environmentIntensity).toBe(0);

    const seeded = applyEnvironmentEffect(neutralized, "dust");
    expect(seeded.environmentIntensity).toBe(DEFAULT_MOTION_RECIPE.environmentIntensity);
  });
});

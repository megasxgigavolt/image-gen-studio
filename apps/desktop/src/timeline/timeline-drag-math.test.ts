import { describe, expect, it } from "vitest";
import { nextDragBounds, snapTime } from "./timeline-drag-math";

describe("snapTime", () => {
  const pixelsPerSecond = 40; // 6px threshold => 0.15s

  it("returns the time unchanged when disabled", () => {
    expect(snapTime(5, [5.1], false, pixelsPerSecond)).toEqual({ value: 5, snapped: false });
  });

  it("returns the time unchanged when there are no targets", () => {
    expect(snapTime(5, [], true, pixelsPerSecond)).toEqual({ value: 5, snapped: false });
  });

  it("snaps to the nearest target within the pixel threshold", () => {
    expect(snapTime(5, [5.1, 9], true, pixelsPerSecond)).toEqual({ value: 5.1, snapped: true });
  });

  it("does not snap to a target outside the threshold", () => {
    expect(snapTime(5, [6], true, pixelsPerSecond)).toEqual({ value: 5, snapped: false });
  });

  it("picks the closest of several in-range targets", () => {
    expect(snapTime(5, [5.12, 4.95], true, pixelsPerSecond)).toEqual({ value: 4.95, snapped: true });
  });

  it("shrinks the threshold as pixels-per-second increases (constant on-screen distance)", () => {
    // At 400px/s a 6px threshold is 0.015s — 0.05s away no longer snaps.
    expect(snapTime(5, [5.05], true, 400)).toEqual({ value: 5, snapped: false });
  });

  it("is a no-op when pixelsPerSecond is zero or negative", () => {
    expect(snapTime(5, [5.01], true, 0)).toEqual({ value: 5, snapped: false });
  });
});

describe("nextDragBounds", () => {
  const pixelsPerSecond = 40;

  it("start mode clamps to the clip's own end minus the minimum duration", () => {
    const result = nextDragBounds("start", 2, 10, 2, 12, pixelsPerSecond);
    expect(result).toEqual({ start: 9.9, end: 10, snappedAt: null });
  });

  it("start mode never goes negative", () => {
    const result = nextDragBounds("start", 2, 10, 2, -5, pixelsPerSecond);
    expect(result.start).toBe(0);
    expect(result.end).toBe(10);
  });

  it("end mode clamps to the clip's own start plus the minimum duration", () => {
    const result = nextDragBounds("end", 2, 10, 10, 1, pixelsPerSecond);
    expect(result).toEqual({ start: 2, end: 2.1, snappedAt: null });
  });

  it("move mode shifts both edges by the pointer delta, preserving duration", () => {
    const result = nextDragBounds("move", 2, 10, 5, 8, pixelsPerSecond);
    // delta = 8 - 5 = 3; duration = 8
    expect(result).toEqual({ start: 5, end: 13, snappedAt: null });
  });

  it("move mode never drags the start below zero", () => {
    const result = nextDragBounds("move", 2, 10, 5, 0, pixelsPerSecond);
    expect(result.start).toBe(0);
    expect(result.end).toBe(8);
  });

  it("snaps the moving edge onto a target and reports where", () => {
    const result = nextDragBounds("start", 2, 10, 2, 3.05, pixelsPerSecond, [3], true);
    expect(result).toEqual({ start: 3, end: 10, snappedAt: 3 });
  });

  it("does not snap when snapEnabled is false (Shift held)", () => {
    const result = nextDragBounds("start", 2, 10, 2, 3.05, pixelsPerSecond, [3], false);
    expect(result.snappedAt).toBeNull();
    expect(result.start).toBe(3.05);
  });
});

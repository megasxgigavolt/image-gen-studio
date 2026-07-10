import { describe, expect, it } from "vitest";
import { clampAgainstNeighbors, clampMoveAgainstNeighbors, formatTime, pixelsToSeconds, secondsToPixels } from "./timecode";

describe("formatTime", () => {
  it("formats seconds as CapCut-style timecode", () => {
    expect(formatTime(5)).toBe("00:00:05:00");
    expect(formatTime(65.5)).toBe("00:01:05:15");
    expect(formatTime(3661.25)).toBe("01:01:01:08");
  });

  it("rounds to the nearest frame and clamps negative values", () => {
    expect(formatTime(1.999)).toBe("00:00:02:00");
    expect(formatTime(-3)).toBe("00:00:00:00");
  });
});

describe("secondsToPixels / pixelsToSeconds", () => {
  it("round-trip converts using pixels-per-second", () => {
    expect(secondsToPixels(4, 50)).toBe(200);
    expect(pixelsToSeconds(200, 50)).toBe(4);
  });

  it("pixelsToSeconds is safe against a zero/negative rate", () => {
    expect(pixelsToSeconds(100, 0)).toBe(0);
    expect(pixelsToSeconds(100, -10)).toBe(0);
  });
});

describe("clampAgainstNeighbors", () => {
  it("leaves a proposed range untouched when there is no conflict", () => {
    expect(clampAgainstNeighbors([{ start: 0, end: 2 }], 5, 8)).toEqual({ start: 5, end: 8 });
  });

  it("clamps the start against a preceding clip", () => {
    expect(clampAgainstNeighbors([{ start: 0, end: 4 }], 3, 6)).toEqual({ start: 4, end: 7 });
  });

  it("clamps the end against a following clip, preserving duration when room allows", () => {
    expect(clampAgainstNeighbors([{ start: 8, end: 10 }], 6, 9)).toEqual({ start: 5, end: 8 });
  });

  it("never returns a negative start", () => {
    expect(clampAgainstNeighbors([], -5, -2)).toEqual({ start: 0, end: 3 });
  });
});

describe("clampMoveAgainstNeighbors", () => {
  it("leaves a proposed move untouched when there is no conflict", () => {
    expect(clampMoveAgainstNeighbors([{ start: 0, end: 2 }], 5, 3)).toEqual({ start: 5, end: 8 });
  });

  it("stops at a following neighbor without shrinking duration", () => {
    expect(clampMoveAgainstNeighbors([{ start: 8, end: 10 }], 6, 3)).toEqual({ start: 5, end: 8 });
  });

  it("stops at a preceding neighbor without shrinking duration", () => {
    expect(clampMoveAgainstNeighbors([{ start: 0, end: 4 }], 3, 3)).toEqual({ start: 4, end: 7 });
  });

  it("pins to the previous clip when the gap is smaller than the duration", () => {
    expect(clampMoveAgainstNeighbors([{ start: 0, end: 4 }, { start: 5, end: 10 }], 4.2, 3)).toEqual({ start: 4, end: 7 });
  });
});

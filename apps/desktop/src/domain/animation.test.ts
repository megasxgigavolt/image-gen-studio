import { describe, expect, it } from "vitest";
import { pickVeoDuration } from "./animation";

describe("pickVeoDuration", () => {
  it("picks the largest supported duration that fits the gap", () => {
    expect(pickVeoDuration(8)).toBe(8);
    expect(pickVeoDuration(7.9)).toBe(6);
    expect(pickVeoDuration(6)).toBe(6);
    expect(pickVeoDuration(5.9)).toBe(4);
    expect(pickVeoDuration(4)).toBe(4);
  });

  it("falls back to the shortest duration when the gap is under 4s", () => {
    expect(pickVeoDuration(3)).toBe(4);
    expect(pickVeoDuration(0)).toBe(4);
  });
});

import { describe, expect, it } from "vitest";
import { formatTime } from "./timecode";

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

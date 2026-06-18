import { describe, expect, it } from "vitest";
import { deriveGroupTiming, type Sentence, type VisualPlanGroup } from "./visual-plan";

const sentences: Sentence[] = [
  { id: "s1", startSeconds: 2, endSeconds: 5, text: "First." },
  { id: "s2", startSeconds: 5, endSeconds: 9.5, text: "Second." },
];

describe("deriveGroupTiming", () => {
  it("derives timestamps from the first and last sentence", () => {
    const group: VisualPlanGroup = {
      id: "g1",
      label: "Opening",
      kind: "establishing",
      sentenceIds: ["s2", "s1"],
    };

    expect(deriveGroupTiming(group, sentences)).toMatchObject({
      startSeconds: 2,
      endSeconds: 9.5,
      durationSeconds: 7.5,
    });
  });
});

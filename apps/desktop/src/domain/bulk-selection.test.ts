import { describe, expect, it } from "vitest";
import { sceneSelectionState, toggleScene } from "./bulk-selection";

describe("sceneSelectionState", () => {
  it("reads 'none' when nothing in the scene is selected", () => {
    expect(sceneSelectionState(["g1", "g2"], new Set())).toBe("none");
  });

  it("reads 'all' when every still in the scene is selected", () => {
    expect(sceneSelectionState(["g1", "g2"], new Set(["g1", "g2", "g3"]))).toBe("all");
  });

  it("reads 'some' when only part of the scene is selected", () => {
    expect(sceneSelectionState(["g1", "g2"], new Set(["g1"]))).toBe("some");
  });

  it("reads 'none' for a scene with no stills", () => {
    expect(sceneSelectionState([], new Set(["g1"]))).toBe("none");
  });
});

describe("toggleScene", () => {
  it("selects every still in the scene when none are selected", () => {
    const next = toggleScene(["g1", "g2"], new Set());
    expect([...next].sort()).toEqual(["g1", "g2"]);
  });

  it("clears every still in the scene when some are selected, without touching other scenes' selections", () => {
    const next = toggleScene(["g1", "g2"], new Set(["g1", "g3"]));
    expect([...next].sort()).toEqual(["g3"]);
  });

  it("clears every still in the scene when all are selected", () => {
    const next = toggleScene(["g1", "g2"], new Set(["g1", "g2"]));
    expect(next.size).toBe(0);
  });
});

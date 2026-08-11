import { describe, expect, it } from "vitest";
import { deriveGroupTiming, sectionGroupsByScene, type Sentence, type VisualPlanGroup } from "./visual-plan";

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

describe("sectionGroupsByScene", () => {
  type Group = { id: string; sceneId: string | null };
  type Scene = { id: string; label: string };

  const scenes: Scene[] = [
    { id: "sc1", label: "Hook" },
    { id: "sc2", label: "Premise" },
  ];

  it("groups consecutive same-scene stills into one section per scene", () => {
    const groups: Group[] = [
      { id: "g1", sceneId: "sc1" },
      { id: "g2", sceneId: "sc1" },
      { id: "g3", sceneId: "sc2" },
    ];

    const sections = sectionGroupsByScene(groups, scenes);

    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({ scene: { id: "sc1" }, groups: [{ id: "g1" }, { id: "g2" }] });
    expect(sections[1]).toMatchObject({ scene: { id: "sc2" }, groups: [{ id: "g3" }] });
  });

  it("renders a still with no matching scene as a null-scene section instead of erroring", () => {
    const groups: Group[] = [{ id: "g1", sceneId: "does-not-exist" }, { id: "g2", sceneId: null }];

    const sections = sectionGroupsByScene(groups, scenes);

    expect(sections).toHaveLength(1);
    expect(sections[0].scene).toBeNull();
    expect(sections[0].groups).toHaveLength(2);
  });

  it("starts a new section when scene membership changes back and forth", () => {
    const groups: Group[] = [
      { id: "g1", sceneId: "sc1" },
      { id: "g2", sceneId: "sc2" },
      { id: "g3", sceneId: "sc1" },
    ];

    const sections = sectionGroupsByScene(groups, scenes);

    expect(sections.map((section) => section.scene?.id)).toEqual(["sc1", "sc2", "sc1"]);
  });
});

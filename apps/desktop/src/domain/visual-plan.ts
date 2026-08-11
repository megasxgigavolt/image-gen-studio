export type Sentence = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type VisualPlanGroup = {
  id: string;
  label: string;
  kind: "establishing" | "subject" | "concept" | "custom";
  sentenceIds: string[];
};

export function deriveGroupTiming(
  group: VisualPlanGroup,
  sentences: Sentence[],
) {
  const members = group.sentenceIds
    .map((id) => sentences.find((sentence) => sentence.id === id))
    .filter((sentence): sentence is Sentence => Boolean(sentence))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  if (members.length === 0) {
    throw new Error(`Visual plan group ${group.id} contains no sentences.`);
  }

  const startSeconds = members[0].startSeconds;
  const endSeconds = members[members.length - 1].endSeconds;

  return {
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds,
    members,
  };
}

/** One scene strip's worth of stills, in the flat `.plan-list` order the
 * Visual Plan view renders — a section's `scene` is null for stills with no
 * matching scene (plans generated before scenes existed, or a still whose
 * sceneId doesn't resolve), which the view renders with no strip at all
 * rather than treating as an error. Consecutive same-scene (or consecutive
 * null-scene) groups collapse into one section, not one per group, so a
 * scene's strip only ever renders once before its first still. */
export type SceneSection<
  TGroup extends { sceneId?: string | null },
  TScene extends { id: string },
> = {
  scene: TScene | null;
  groups: TGroup[];
};

export function sectionGroupsByScene<
  TGroup extends { sceneId?: string | null },
  TScene extends { id: string },
>(groups: TGroup[], scenes: TScene[]): SceneSection<TGroup, TScene>[] {
  const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
  const sections: SceneSection<TGroup, TScene>[] = [];

  for (const group of groups) {
    const scene = (group.sceneId && scenesById.get(group.sceneId)) || null;
    const current = sections.at(-1);
    if (current && current.scene?.id === scene?.id) {
      current.groups.push(group);
    } else {
      sections.push({ scene, groups: [group] });
    }
  }

  return sections;
}

export function canMoveSentenceChronologically(
  sentenceId: string,
  targetGroupId: string,
  groups: VisualPlanGroup[],
) {
  const sentenceOrder = groups
    .flatMap((group) => group.sentenceIds)
    .indexOf(sentenceId);
  const targetOrder = groups.findIndex((group) => group.id === targetGroupId);
  const sourceOrder = groups.findIndex((group) =>
    group.sentenceIds.includes(sentenceId),
  );

  if (sentenceOrder < 0 || targetOrder < 0 || sourceOrder < 0) return false;
  return Math.abs(targetOrder - sourceOrder) <= 1;
}

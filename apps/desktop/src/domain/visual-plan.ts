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

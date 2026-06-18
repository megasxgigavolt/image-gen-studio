import type { Sentence, VisualPlanGroup } from "../domain/visual-plan";

export const demoSentences: Sentence[] = [
  { id: "s1", startSeconds: 0, endSeconds: 4.1, text: "The sunlight fades beneath the waves." },
  { id: "s2", startSeconds: 4.1, endSeconds: 8.4, text: "The familiar blue begins to disappear." },
  { id: "s3", startSeconds: 8.4, endSeconds: 13.2, text: "Two hundred meters down, a hidden world begins." },
  { id: "s4", startSeconds: 13.2, endSeconds: 17.2, text: "Oceanographers call it the twilight zone." },
  { id: "s5", startSeconds: 17.2, endSeconds: 21.3, text: "Here, every fragment of light becomes precious." },
  { id: "s6", startSeconds: 21.3, endSeconds: 26.4, text: "Vision gives way to other, stranger senses." },
];

export const originalDemoPlan: VisualPlanGroup[] = [
  { id: "g1", label: "Ocean descent", kind: "establishing", sentenceIds: ["s1", "s2"] },
  { id: "g2", label: "Twilight boundary", kind: "subject", sentenceIds: ["s3", "s4"] },
  { id: "g3", label: "Precious light", kind: "concept", sentenceIds: ["s5", "s6"] },
];

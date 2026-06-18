import { create } from "zustand";
import { originalDemoPlan } from "../data/demo";
import type { VisualPlanGroup } from "../domain/visual-plan";

export type AppStage = "home" | "inputs" | "visual-plan" | "images";
export type Theme = "light" | "dark";

type AppState = {
  stage: AppStage;
  theme: Theme;
  visualPlan: VisualPlanGroup[];
  activeChannelId: string | null;
  activeChannelName: string | null;
  activeVideoId: string | null;
  activeVideoTitle: string | null;
  setStage: (stage: AppStage) => void;
  toggleTheme: () => void;
  resetVisualPlan: () => void;
  moveSentence: (sentenceId: string, targetGroupId: string) => void;
  setActiveProject: (
    channelId: string,
    channelName: string,
    videoId: string,
    videoTitle: string,
  ) => void;
};

const cloneOriginalPlan = () =>
  originalDemoPlan.map((group) => ({
    ...group,
    sentenceIds: [...group.sentenceIds],
  }));

export const useAppStore = create<AppState>((set) => ({
  stage: "home",
  theme: "light",
  visualPlan: cloneOriginalPlan(),
  activeChannelId: null,
  activeChannelName: null,
  activeVideoId: null,
  activeVideoTitle: null,
  setStage: (stage) => set({ stage }),
  toggleTheme: () =>
    set((state) => ({ theme: state.theme === "light" ? "dark" : "light" })),
  resetVisualPlan: () => set({ visualPlan: cloneOriginalPlan() }),
  setActiveProject: (channelId, channelName, videoId, videoTitle) =>
    set({
      activeChannelId: channelId,
      activeChannelName: channelName,
      activeVideoId: videoId,
      activeVideoTitle: videoTitle,
    }),
  moveSentence: (sentenceId, targetGroupId) =>
    set((state) => {
      const sourceIndex = state.visualPlan.findIndex((group) =>
        group.sentenceIds.includes(sentenceId),
      );
      const targetIndex = state.visualPlan.findIndex(
        (group) => group.id === targetGroupId,
      );
      if (
        sourceIndex < 0 ||
        targetIndex < 0 ||
        sourceIndex === targetIndex ||
        Math.abs(sourceIndex - targetIndex) > 1
      ) {
        return state;
      }

      const visualPlan = state.visualPlan.map((group) => ({
        ...group,
        sentenceIds: group.sentenceIds.filter((id) => id !== sentenceId),
      }));
      visualPlan[targetIndex].sentenceIds.push(sentenceId);
      visualPlan[targetIndex].sentenceIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      return {
        visualPlan: visualPlan.filter((group) => group.sentenceIds.length > 0),
      };
    }),
}));

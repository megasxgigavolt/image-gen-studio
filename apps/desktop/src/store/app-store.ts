import { create } from "zustand";
import type { ReactNode } from "react";
import { originalDemoPlan } from "../data/demo";
import type { VisualPlanGroup } from "../domain/visual-plan";

export type AppStage = "home" | "inputs" | "visual-plan" | "images" | "animate" | "timeline" | "tools";

/** videoId → groupId. Lets one stage (e.g. the Editor's "Go to this still in
 * Visuals" context menu action) pre-seed which still the Images stage
 * restores as selected when it next mounts. */
export const lastSelectedStill = new Map<string, string>();
export type Theme = "light" | "dark";

type Toast = { id: number; message: string; kind: "success" | "error" | "info"; durationMs: number };

type AppState = {
  stage: AppStage;
  theme: Theme;
  visualPlan: VisualPlanGroup[];
  activeChannelId: string | null;
  activeChannelName: string | null;
  activeVideoId: string | null;
  activeVideoTitle: string | null;
  lastProductionStage: "inputs" | "visual-plan";
  toast: Toast | null;
  /** Per-page action content (buttons/menus) rendered in the titlebar — set
   * by whichever view owns it (e.g. the Editor tab's Export controls) and
   * cleared on unmount, since the titlebar itself has no page context. */
  titlebarActions: ReactNode | null;
  setTitlebarActions: (actions: ReactNode | null) => void;
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
  clearActiveProject: () => void;
  addToast: (message: string, kind?: Toast["kind"], durationMs?: number) => void;
  dismissToast: () => void;
};

const cloneOriginalPlan = () =>
  originalDemoPlan.map((group) => ({
    ...group,
    sentenceIds: [...group.sentenceIds],
  }));

let toastCounter = 0;

export const useAppStore = create<AppState>((set) => ({
  stage: "home",
  theme: "light",
  visualPlan: cloneOriginalPlan(),
  activeChannelId: null,
  activeChannelName: null,
  activeVideoId: null,
  activeVideoTitle: null,
  lastProductionStage: "inputs",
  toast: null,
  titlebarActions: null,
  setTitlebarActions: (actions) => set({ titlebarActions: actions }),
  setStage: (stage) =>
    set((state) => ({
      stage,
      lastProductionStage:
        stage === "inputs" || stage === "visual-plan"
          ? stage
          : state.lastProductionStage,
    })),
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
  clearActiveProject: () =>
    set({
      activeChannelId: null,
      activeChannelName: null,
      activeVideoId: null,
      activeVideoTitle: null,
    }),
  addToast: (message, kind = "info", durationMs = 4500) =>
    set({ toast: { id: ++toastCounter, message, kind, durationMs } }),
  dismissToast: () => set({ toast: null }),
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

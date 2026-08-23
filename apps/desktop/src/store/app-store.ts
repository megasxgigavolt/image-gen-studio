import { create } from "zustand";
import type { ReactNode } from "react";
import { originalDemoPlan } from "../data/demo";
import type { VisualPlanGroup } from "../domain/visual-plan";

export type AppStage = "home" | "inputs" | "visual-plan" | "images" | "animate" | "timeline" | "tools";

/** videoId → groupId. Lets one stage (e.g. the Editor's "Go to this still in
 * Visuals" context menu action) pre-seed which still the Images stage
 * restores as selected when it next mounts. */
export const lastSelectedStill = new Map<string, string>();

/** videoId → last Editor-tab playhead/selection, restored the next time
 * TimelineView mounts for that video. The stage router (App.tsx) fully
 * unmounts TimelineView on every stage switch, so none of its local state
 * survives on its own — same "outlives unmount, keyed by video" idiom as
 * lastSelectedStill above. Selected clip isn't tracked here: it's derived
 * from playhead position (see TimelineView's updateSelectionForTime), so
 * restoring playheadSeconds via seekPreview brings it back for free. */
export interface TimelineViewMemory {
  playheadSeconds: number;
  selectedCaptionClipId: string | null;
  selectedTrack: "narration" | null;
}
export const lastTimelineViewState = new Map<string, TimelineViewMemory>();

/** videoId → Visual tab's plan-list scroll position, restored the next time
 * VisualPlanView mounts for that video. Same idiom as the two maps above. */
export const lastVisualPlanScrollTop = new Map<string, number>();

/** videoId → the Images/Visuals stage's stills-list scroll position,
 * restored the next time ImagesView mounts for that video. Same idiom as
 * the maps above — ImagesView fully unmounts on stage switch too. */
export const lastVisualsStillListScrollTop = new Map<string, number>();
export type Theme = "light" | "dark";

type Toast = { id: number; message: string; kind: "success" | "error" | "info"; durationMs: number };

export type ExportKind = "video" | "project";
export type ExportUiResult = { kind: "success"; path: string } | { kind: "failure"; error: string };

/** Tracks an in-flight (or just-finished, until dismissed) timeline export.
 * Lives in the store — not TimelineView's own local state — specifically so
 * it survives the Editor tab unmounting: the stage router (App.tsx) fully
 * unmounts TimelineView on every stage switch, but the export itself keeps
 * running regardless (it's a single long-awaited backend invoke; nothing
 * about navigating away cancels it), and the `export-progress` Tauri event
 * is a plain window-level subscription with no tie to any component's
 * lifecycle either — before this, switching tabs mid-export just meant the
 * UI silently lost all track of it until you happened to come back. See
 * App.tsx's own `export-progress` listener (subscribed once, for the app's
 * whole lifetime) and the persistent mini export badge it renders. */
export type ExportState = {
  videoId: string;
  kind: ExportKind;
  percent: number;
  stage: string;
  detail: string;
  cancelling: boolean;
  result: ExportUiResult | null;
};

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
  exportState: ExportState | null;
  /** Manually collapsed (chevron in the Editor tab) to just the mini badge
   * while still on the Editor tab — separate from "not on the Editor tab at
   * all", which shows the same badge for a different reason. Reset false on
   * every new export so a fresh export always opens expanded. */
  exportCollapsed: boolean;
  beginExport: (videoId: string, kind: ExportKind) => void;
  updateExportProgress: (videoId: string, percent: number, stage: string, detail: string) => void;
  setExportCancelling: (videoId: string, cancelling: boolean) => void;
  finishExport: (videoId: string, result: ExportUiResult | null) => void;
  clearExport: () => void;
  setExportCollapsed: (collapsed: boolean) => void;
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
  exportState: null,
  exportCollapsed: false,
  beginExport: (videoId, kind) =>
    set({
      exportState: { videoId, kind, percent: 0, stage: "Preparing export", detail: "", cancelling: false, result: null },
      exportCollapsed: false,
    }),
  updateExportProgress: (videoId, percent, stage, detail) =>
    set((state) =>
      state.exportState?.videoId === videoId
        ? { exportState: { ...state.exportState, percent, stage, detail } }
        : state,
    ),
  setExportCancelling: (videoId, cancelling) =>
    set((state) =>
      state.exportState?.videoId === videoId
        ? { exportState: { ...state.exportState, cancelling } }
        : state,
    ),
  finishExport: (videoId, result) =>
    set((state) =>
      state.exportState?.videoId === videoId
        ? { exportState: { ...state.exportState, result, cancelling: false } }
        : state,
    ),
  clearExport: () => set({ exportState: null, exportCollapsed: false }),
  setExportCollapsed: (collapsed) => set({ exportCollapsed: collapsed }),
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

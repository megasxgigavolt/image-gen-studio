import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineView } from "./TimelineView";
import { useAppStore } from "./store/app-store";
import { projectsClient, type ImageWorkspaceRecord, type TimelineRecord, type VideoInputsRecord } from "./infrastructure/projects-client";

const EMPTY_WORKSPACE: ImageWorkspaceRecord = {
  videoId: "video-1",
  sentences: [],
  groups: [],
  settings: [],
  scenes: [],
};

const EMPTY_INPUTS: VideoInputsRecord = {
  videoId: "video-1",
  scriptText: "",
  pacingSeconds: 8,
  pacingPreset: "balanced",
  pacingMinSeconds: 6,
  pacingMaxSeconds: 10,
  audio: null,
  references: [],
  updatedAt: new Date().toISOString(),
  planMatchesCurrentInputs: null,
};

const EMPTY_TIMELINE: TimelineRecord = {
  videoId: "video-1",
  durationSeconds: 0,
  playheadSeconds: 0,
  zoom: 1,
  updatedAt: new Date().toISOString(),
  clips: [],
  captionClips: [],
  captionStyle: {},
  narrationOffsetSeconds: 0,
  musicClips: [],
  textClips: [],
  logoClips: [],
  musicMasterVolumePercent: 100,
  musicDuckSensitivityPercent: 50,
  sequenceLocked: true,
  narrationVolumePercent: 100,
  narrationTrimStartSeconds: 0,
  narrationTrimEndSeconds: 0,
};

function mockLoadedEditor() {
  vi.spyOn(projectsClient, "getImageWorkspace").mockResolvedValue(EMPTY_WORKSPACE);
  vi.spyOn(projectsClient, "getVideoInputs").mockResolvedValue(EMPTY_INPUTS);
  vi.spyOn(projectsClient, "getCaptions").mockRejectedValue(new Error("no captions"));
  vi.spyOn(projectsClient, "getTimeline").mockResolvedValue(EMPTY_TIMELINE);
  vi.spyOn(projectsClient, "listMediaLibraryAssets").mockResolvedValue([]);
  vi.spyOn(projectsClient, "listVideoAssets").mockResolvedValue([]);
}

describe("TimelineView", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ activeVideoId: null, activeVideoTitle: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prompts to open a video when none is active", () => {
    render(<TimelineView />);
    expect(screen.getByText(/open a video first/i)).toBeInTheDocument();
  });

  it("renders the Editor shell once the timeline loads, even with nothing on it yet", async () => {
    mockLoadedEditor();
    useAppStore.setState({ activeVideoId: "video-1", activeVideoTitle: "My Video" });
    render(<TimelineView />);

    expect(await screen.findByRole("heading", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByText(/add stills to the timeline to begin editing/i)).toBeInTheDocument();
    expect(screen.getByText(/select a clip or audio in the timeline/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /captions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /undo/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /redo/i })).toBeDisabled();
  });

  it("Escape closes the captions tool back to the empty inspector state", async () => {
    mockLoadedEditor();
    useAppStore.setState({ activeVideoId: "video-1", activeVideoTitle: "My Video" });
    render(<TimelineView />);

    const captionsButton = await screen.findByRole("button", { name: /captions/i });
    fireEvent.click(captionsButton);
    expect(await screen.findByRole("button", { name: /generate captions/i })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(screen.getByText(/select a clip or audio in the timeline/i)).toBeInTheDocument();
    });
  });
});

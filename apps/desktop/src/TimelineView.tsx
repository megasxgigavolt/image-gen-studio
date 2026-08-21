import {
  Clock,
  Download,
  Keyboard,
  LoaderCircle,
  Lock,
  Move,
  MoreHorizontal,
  Play,
  Sparkles,
  Square,
  Trash2,
  Undo2,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent } from "react";
import { lastSelectedStill, lastTimelineViewState, useAppStore } from "./store/app-store";
import { formatTime, secondsToPixels } from "./domain/timecode";
import { setCachedData } from "./infrastructure/media-cache";
import {
  projectsClient,
  type CaptionStyle,
  type ExportSettingsRecord,
  type ImageRenderRecord,
  type TimelineCaptionClipRecord,
  type TimelineClipRecord,
  type TimelineMusicClipRecord,
  type TimelineTextClipRecord,
  type VideoAssetRecord,
} from "./infrastructure/projects-client";
import { MediaLibraryPanel, MEDIA_DRAG_MIME, type MediaDragPayload } from "./timeline/MediaLibraryPanel";
import { ContextMenu, type ContextMenuItem } from "./timeline/ContextMenu";
import { Toolbar, type AspectRatio, type ToolKind } from "./timeline/Toolbar";
import { ExportDrawer } from "./timeline/ExportDrawer";
import { ExportHistoryModal } from "./timeline/ExportHistoryModal";
import { MusicTool } from "./timeline/tools/MusicTool";
import { MotionTool } from "./timeline/tools/MotionTool";
import { TextOverlayTool } from "./timeline/tools/TextOverlayTool";
import { PlaybackControls, ZOOM_MAX, ZOOM_MIN } from "./timeline/EditorToolbar";
import { TimelinePreview } from "./timeline/TimelinePreview";
import { TimelineTracks } from "./timeline/TimelineTracks";
import { ClipInspector } from "./timeline/ClipInspector";
import { CaptionsInspector } from "./timeline/CaptionsInspector";
import { DEFAULT_CAPTION_STYLE, findClipAtTime } from "./timeline/timeline-rendering";
import { isTypingTarget, resolveShortcutAction } from "./timeline/shortcut-resolver";
import { useTimelineData } from "./timeline/useTimelineData";
import { useTimelineAssets } from "./timeline/useTimelineAssets";
import { useTimelinePlayback } from "./timeline/useTimelinePlayback";
import { useTimelineDrag } from "./timeline/useTimelineDrag";

const BASE_PIXELS_PER_SECOND = 40;
// Matches the arrow-key seek step so toolbar step buttons and the keyboard
// shortcut move the playhead by the same amount.
const FRAME_STEP_SECONDS = 1 / 30;
const CLIP_JUMP_EPSILON = 0.05;

// A year is far more than this app's autosave cadence could ever produce
// legitimately — anything beyond it means the timestamp is corrupt, not that
// the save is actually that old (this is what used to render as absurdities
// like "Saved 388h ago" once elapsed time crossed a day with no cap).
const MAX_PLAUSIBLE_SAVE_AGE_SECONDS = 60 * 60 * 24 * 365;

function formatSavedRelativeTime(isoTimestamp: string): string {
  const savedAt = new Date(isoTimestamp).getTime();
  const elapsedSeconds = Math.round((Date.now() - savedAt) / 1000);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > MAX_PLAUSIBLE_SAVE_AGE_SECONDS) {
    return "Saved just now";
  }
  if (elapsedSeconds < 60) return "Saved just now";
  const minutes = Math.round(elapsedSeconds / 60);
  if (minutes < 60) return `Saved ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(elapsedSeconds / 3600);
  if (hours < 24) return `Saved ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `Saved ${new Date(savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export function TimelineView() {
  const { activeVideoId, activeVideoTitle, addToast, setTitlebarActions, setStage } = useAppStore();

  const [selectedClip, setSelectedClip] = useState<TimelineClipRecord | null>(null);
  const [selectedClipRenders, setSelectedClipRenders] = useState<ImageRenderRecord[]>([]);
  const [confirmExportProject, setConfirmExportProject] = useState(false);
  const [exportDrawerOpen, setExportDrawerOpen] = useState(false);
  const [exportKind, setExportKind] = useState<"video" | "project" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportCancelling, setExportCancelling] = useState(false);
  const [exportProgress, setExportProgress] = useState({ percent: 0, stage: "Preparing export", detail: "" });
  const [exportSettings, setExportSettings] = useState<ExportSettingsRecord>({
    resolution: "1080p", quality: "high", captionsMode: "burned-in", includeNarration: true, includeMusic: true,
  });
  // Preferences' Export Defaults pre-fill the panel once per mount — after
  // that the user's own picks in this session take priority, so this must
  // not re-run on every settings change.
  useEffect(() => {
    void (async () => {
      const [resolution, quality, captionsMode] = await Promise.all([
        projectsClient.getAppSetting("export_default_resolution"),
        projectsClient.getAppSetting("export_default_quality"),
        projectsClient.getAppSetting("export_default_captions"),
      ]);
      setExportSettings((current) => ({
        ...current,
        resolution: (resolution as ExportSettingsRecord["resolution"]) || current.resolution,
        quality: (quality as ExportSettingsRecord["quality"]) || current.quality,
        captionsMode: (captionsMode as ExportSettingsRecord["captionsMode"]) || current.captionsMode,
      }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [exportResult, setExportResult] = useState<{ kind: "success"; path: string } | { kind: "failure"; error: string } | null>(null);
  const [exportHistoryOpen, setExportHistoryOpen] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolKind | null>(null);
  const [titlebarMenuOpen, setTitlebarMenuOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [selectedMusicClip, setSelectedMusicClip] = useState<TimelineMusicClipRecord | null>(null);
  const [selectedTextClip, setSelectedTextClip] = useState<TimelineTextClipRecord | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<"narration" | null>(null);
  const [durationDraft, setDurationDraft] = useState<string | null>(null);
  const [textOverlayFocusRequestId] = useState(0);
  const [autosaveTick, setAutosaveTick] = useState(0);
  // "Remove all effects" (Toolbar) still needs a fixed intensity value to
  // pass through to the reset-to-"none" call below — no UI sets this
  // anymore since the per-clip intensity slider was removed from the
  // inspector, so it's a constant rather than state now.
  const globalIntensity = 0.22;
  const [selectedClipVideoAsset, setSelectedClipVideoAsset] = useState<VideoAssetRecord | null>(null);
  const [retiming, setRetiming] = useState(false);
  const [extrapolating, setExtrapolating] = useState(false);
  // "running"/"paused" drives the toolbar button + progress label; the ref is
  // what the loop itself checks each iteration to decide whether to keep
  // going — same split React state (for render) / ref (for the loop's own
  // control flow) already used for prompt-prep and Bulk Generation.
  const [motionStatus, setMotionStatus] = useState<"running" | "paused" | null>(null);
  const motionControl = useRef<"running" | "paused" | "stopped">("stopped");
  const [motionGraphicsProgress, setMotionGraphicsProgress] = useState<{ done: number; total: number } | null>(null);
  const [uploadingAnimation, setUploadingAnimation] = useState(false);
  const [selectedCaptionClip, setSelectedCaptionClip] = useState<TimelineCaptionClipRecord | null>(null);
  const [captionText, setCaptionText] = useState("");
  const [generatingCaptions, setGeneratingCaptions] = useState(false);
  const [captionProgress, setCaptionProgress] = useState({ percent: 0, stage: "Preparing captions", detail: "" });
  const [confirmRegenerateCaptions, setConfirmRegenerateCaptions] = useState(false);
  const [confirmResetTimeline, setConfirmResetTimeline] = useState(false);
  const [confirmRemoveAllEffects, setConfirmRemoveAllEffects] = useState(false);
  const [confirmExtrapolateStills, setConfirmExtrapolateStills] = useState(false);
  const [confirmAutoMotion, setConfirmAutoMotion] = useState(false);
  const [resettingTimeline, setResettingTimeline] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [exportFileName, setExportFileName] = useState("");
  // Caption style sliders update these synchronously (so the canvas preview
  // reacts on every drag tick), while the actual backend commit — a full
  // timeline round-trip — is debounced. `undefined` means "no draft, defer to
  // the committed value"; `null` is itself a valid draft (pending reset to
  // inherit-default), so it can't double as the "no draft" sentinel.
  const [pendingGlobalCaptionStyle, setPendingGlobalCaptionStyle] = useState<CaptionStyle | null | undefined>(undefined);
  const [pendingSelectedCaptionStyle, setPendingSelectedCaptionStyle] = useState<CaptionStyle | null | undefined>(undefined);

  const globalStyleCommitRef = useRef<number | null>(null);
  const selectedStyleCommitRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const canvasInnerRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);

  const data = useTimelineData(activeVideoId, () => {
    setSelectedClip(null);
    setSelectedCaptionClip(null);
    setSelectedMusicClip(null);
    setSelectedTextClip(null);
    setSelectedTrack(null);
    setActiveTool(null);
  });
  const { timeline, setTimeline, workspace, captionSet, setCaptionSet, audioDataUrl, loading, error, setError, savingCount, refresh, undo, redo, canUndo, canRedo } = data;

  const redrawRequestRef = useRef<() => void>(() => {});
  const assets = useTimelineAssets(activeVideoId, timeline, workspace, aspectRatio, () => redrawRequestRef.current());
  const { renderUrls, videoAssetUrls, mediaAssetUrls, subjectByRender, canvasSize, getOrLoadVideo, getOrLoadAudio, getImageByAssetId, getSubjectByRenderId } = assets;

  useEffect(() => {
    void projectsClient.getAppSetting("image_settings").then((raw) => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed.aspectRatio === "9:16") setAspectRatio("9:16");
      } catch {
        // Malformed setting — keep the 16:9 default.
      }
    });
  }, []);

  useEffect(() => {
    if (activeVideoTitle && !exportFileName) setExportFileName(activeVideoTitle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoTitle]);

  async function handleAspectRatioChange(ratio: AspectRatio) {
    setAspectRatio(ratio);
    try {
      const raw = await projectsClient.getAppSetting("image_settings");
      const parsed = raw ? JSON.parse(raw) : {};
      await projectsClient.saveAppSetting("image_settings", JSON.stringify({ ...parsed, aspectRatio: ratio }));
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  const [narrationDuration, setNarrationDuration] = useState(0);
  const [nativeAudioDuration, setNativeAudioDuration] = useState(0);

  const zoom = timeline?.zoom ?? 1;
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom;
  // Prefer the native <audio> element's duration (the same value export uses
  // to determine true video length) over the Web Audio API's decoded-buffer
  // duration used for the waveform — for compressed audio (MP3/AAC) these can
  // differ by tens to a hundred-plus milliseconds due to encoder padding,
  // which previously made "Extrapolate stills to fill gaps" stretch stills to
  // a slightly-too-short duration, leaving a small trailing gap at export.
  const totalDuration = Math.max(timeline?.durationSeconds ?? 0, nativeAudioDuration || narrationDuration, 1);
  const totalWidthPx = secondsToPixels(totalDuration, pixelsPerSecond);
  // Memoized so these keep a stable reference across the ~15/sec re-renders
  // a playing preview drives (see useTimelinePlayback's throttled
  // setPreviewTime) — otherwise TimelineLanes' React.memo would see a "new"
  // array on every tick and re-diff every clip/caption regardless.
  const stillsClips = useMemo(() => [...(timeline?.clips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds), [timeline?.clips]);
  const captionClips = useMemo(() => [...(timeline?.captionClips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds), [timeline?.captionClips]);
  const musicClips = useMemo(() => [...(timeline?.musicClips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds), [timeline?.musicClips]);
  const textClips = useMemo(() => [...(timeline?.textClips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds), [timeline?.textClips]);
  const logoClips = timeline?.logoClips ?? [];
  const globalCaptionStyle = timeline?.captionStyle ?? {};
  const captionInterval = captionSet?.intervalSeconds ?? 1;
  // Draft takes priority over the committed value while a style edit's
  // backend commit is still debounced/in flight — see the comment on
  // pendingGlobalCaptionStyle's declaration.
  const effectiveGlobalCaptionStyle = pendingGlobalCaptionStyle !== undefined ? pendingGlobalCaptionStyle ?? {} : globalCaptionStyle;
  const effectiveSelectedCaptionStyle = pendingSelectedCaptionStyle !== undefined ? pendingSelectedCaptionStyle : (selectedCaptionClip?.style ?? null);

  function updateSelectionForTime(time: number) {
    const clip = findClipAtTime(stillsClips, time);
    setSelectedClip((current) => {
      if (clip) return current?.id === clip.id ? current : clip;
      return current === null ? current : null;
    });
  }

  const narrationStart = timeline?.narrationOffsetSeconds ?? 0;
  const narrationEnd = narrationStart + (nativeAudioDuration || narrationDuration);

  const playback = useTimelinePlayback({
    timeline, stillsClips, captionClips, totalDuration, canvasSize,
    renderUrls, videoAssetUrls, mediaAssetUrls, subjectByRender, getImageByAssetId, getSubjectByRenderId, getOrLoadVideo, getOrLoadAudio,
    effectiveGlobalCaptionStyle, pendingSelectedCaptionStyle, selectedCaptionClip, audioDataUrl,
    previewCanvasRef, audioRef, canvasScrollRef, pixelsPerSecond,
    musicClips, musicMasterVolumePercent: timeline?.musicMasterVolumePercent ?? 100, musicDuckSensitivityPercent: timeline?.musicDuckSensitivityPercent ?? 0,
    narrationStart, narrationEnd,
    onTimeChange: updateSelectionForTime,
  });
  const { previewTime, previewTimeRef, isPlaying, isPlayingRef, playPreview, pausePreview, seekPreview } = playback;
  useEffect(() => {
    redrawRequestRef.current = () => playback.drawFrameRef.current(previewTimeRef.current);
  });

  // Restores wherever the user left off in this video's Editor the last
  // time it was open — the stage router fully unmounts TimelineView on
  // every stage switch, so nothing here survives on its own otherwise. Runs
  // once per video (guarded by the ref) rather than on every `timeline`
  // update, so it doesn't fight a subsequent refresh()/undo/redo. Clip
  // selection isn't restored directly — seekPreview cascades into it via
  // updateSelectionForTime.
  const restoredTimelineViewRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeVideoId || !timeline || restoredTimelineViewRef.current === activeVideoId) return;
    restoredTimelineViewRef.current = activeVideoId;
    const remembered = lastTimelineViewState.get(activeVideoId);
    if (!remembered) return;
    seekPreview(remembered.playheadSeconds);
    setSelectedTrack(remembered.selectedTrack);
    if (remembered.selectedCaptionClipId) {
      const clip = timeline.captionClips.find((candidate) => candidate.id === remembered.selectedCaptionClipId);
      if (clip) setSelectedCaptionClip(clip);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoId, timeline]);

  // Keeps the memory above current as the user plays/scrubs/selects — a
  // plain module-level Map write, not React state, so this never triggers
  // its own re-render. Gated on the restore effect above having already run
  // for this video: without that guard, this fired on the very first render
  // too (activeVideoId set, timeline still null, previewTime still its
  // initial 0) and clobbered the remembered state with zeros before the
  // restore effect (which only runs once `timeline` loads, a later render)
  // ever got a chance to read it back — the bug that made restoration
  // appear to do nothing at all.
  useEffect(() => {
    if (!activeVideoId || restoredTimelineViewRef.current !== activeVideoId) return;
    lastTimelineViewState.set(activeVideoId, {
      playheadSeconds: previewTime,
      selectedCaptionClipId: selectedCaptionClip?.id ?? null,
      selectedTrack,
    });
  }, [activeVideoId, previewTime, selectedCaptionClip, selectedTrack]);

  const drag = useTimelineDrag({
    activeVideoId, timeline, canvasInnerRef, pixelsPerSecond, previewTimeRef, isPlayingRef,
    pausePreview, seekPreview, refresh, stillsClips, captionClips, musicClips, textClips, logoClips,
    narrationStart, narrationEnd,
  });
  const playheadPx = secondsToPixels(previewTime, pixelsPerSecond);

  useEffect(() => {
    if (!selectedClip || !activeVideoId) {
      setSelectedClipRenders([]);
      return;
    }
    void projectsClient.listImageRenders(activeVideoId, selectedClip.groupId).then(setSelectedClipRenders).catch(() => setSelectedClipRenders([]));
  }, [selectedClip, activeVideoId]);

  // Fetches the animation clip's real stored duration so the inspector can
  // tell whether it still matches the slot it currently occupies (the slot
  // may have been resized since the last generation/retime).
  useEffect(() => {
    if (!selectedClip || selectedClip.clipKind !== "animation" || !selectedClip.videoAssetId) {
      setSelectedClipVideoAsset(null);
      return;
    }
    let cancelled = false;
    void projectsClient.getVideoAssetRecord(selectedClip.videoAssetId)
      .then((asset) => { if (!cancelled) setSelectedClipVideoAsset(asset); })
      .catch(() => { if (!cancelled) setSelectedClipVideoAsset(null); });
    return () => { cancelled = true; };
  }, [selectedClip]);

  // Keep the selected clip's snapshot in sync after any mutation (motion,
  // transition, version swap, resize) so the inspector reflects it live.
  useEffect(() => {
    setSelectedClip((current) => {
      if (!current || !timeline) return current;
      return timeline.clips.find((clip) => clip.id === current.id) ?? null;
    });
  }, [timeline]);

  // Same for the selected caption clip, and keep the text editor in sync
  // whenever the underlying clip's text changes (including our own edits).
  useEffect(() => {
    setSelectedCaptionClip((current) => {
      if (!current || !timeline) return current;
      return timeline.captionClips.find((clip) => clip.id === current.id) ?? null;
    });
  }, [timeline]);
  // Same pattern for the selected Music/Text-overlay clip (State 3 / the
  // Text tool's edit form) — keeps them live after drags/setting changes and
  // drops the selection if the clip was deleted.
  useEffect(() => {
    setSelectedMusicClip((current) => {
      if (!current || !timeline) return current;
      return timeline.musicClips.find((clip) => clip.id === current.id) ?? null;
    });
  }, [timeline]);
  useEffect(() => {
    setSelectedTextClip((current) => {
      if (!current || !timeline) return current;
      return timeline.textClips.find((clip) => clip.id === current.id) ?? null;
    });
  }, [timeline]);
  useEffect(() => {
    setCaptionText(selectedCaptionClip?.text ?? "");
  }, [selectedCaptionClip?.id, selectedCaptionClip?.text]);
  // Native <audio> volume tops out at 1.0 — values above 100% aren't
  // achievable without a Web Audio gain node, so this only ever attenuates.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = Math.min(1, (timeline?.narrationVolumePercent ?? 100) / 100);
  }, [timeline?.narrationVolumePercent]);
  // A per-clip style draft belongs to whichever caption was selected when it
  // started — switching to a different caption (or none) must drop it,
  // otherwise the new selection would render with the previous one's
  // in-progress edit.
  useEffect(() => {
    setPendingSelectedCaptionStyle(undefined);
  }, [selectedCaptionClip?.id]);
  useEffect(() => {
    setPendingGlobalCaptionStyle(undefined);
  }, [activeVideoId]);
  useEffect(() => {
    return () => {
      if (globalStyleCommitRef.current) window.clearTimeout(globalStyleCommitRef.current);
      if (selectedStyleCommitRef.current) window.clearTimeout(selectedStyleCommitRef.current);
    };
  }, []);

  async function updateZoom(nextZoom: number) {
    if (!activeVideoId || !timeline) return;
    await refresh(projectsClient.updateTimelineView(activeVideoId, timeline.playheadSeconds, nextZoom), { skipHistory: true });
  }

  /** Zooms while keeping the playhead's on-screen pixel position fixed —
   * without this, zooming re-anchors on the left edge of the scroll
   * container and the playhead visually jumps around. */
  async function zoomKeepingPlayheadFixed(nextZoomRaw: number) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoomRaw));
    const container = canvasScrollRef.current;
    if (!container) { await updateZoom(clamped); return; }
    const anchorPx = secondsToPixels(previewTimeRef.current, pixelsPerSecond);
    const offsetInViewport = anchorPx - container.scrollLeft;
    await updateZoom(clamped);
    requestAnimationFrame(() => {
      const nextContainer = canvasScrollRef.current;
      if (!nextContainer) return;
      const nextPixelsPerSecond = BASE_PIXELS_PER_SECOND * clamped;
      const nextAnchorPx = secondsToPixels(previewTimeRef.current, nextPixelsPerSecond);
      nextContainer.scrollLeft = Math.max(0, nextAnchorPx - offsetInViewport);
    });
  }

  function jumpToPreviousClip() {
    const previous = [...stillsClips].reverse().find((clip) => clip.startSeconds < previewTimeRef.current - CLIP_JUMP_EPSILON);
    if (previous) seekPreview(previous.startSeconds);
  }

  function jumpToNextClip() {
    const next = stillsClips.find((clip) => clip.startSeconds > previewTimeRef.current + CLIP_JUMP_EPSILON);
    if (next) seekPreview(next.startSeconds);
  }

  function stepBackward() {
    seekPreview(previewTimeRef.current - FRAME_STEP_SECONDS);
  }

  function stepForward() {
    seekPreview(previewTimeRef.current + FRAME_STEP_SECONDS);
  }

  function onCanvasWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const step = event.deltaY < 0 ? 0.15 : -0.15;
    void zoomKeepingPlayheadFixed(zoom + step);
  }

  async function selectStillInSource(groupId: string) {
    const clip = stillsClips.find((candidate) => candidate.groupId === groupId);
    if (clip) {
      seekPreview(clip.startSeconds);
      playback.scrollTimelineToTime(clip.startSeconds);
      return;
    }
    // Stills generated after the timeline's initial auto-populate aren't on
    // it yet — add them (additive, never disturbs existing arrangement) and
    // retry the selection instead of pointing at a manual "add" action.
    if (!activeVideoId) return;
    const updated = await projectsClient.populateTimelineFromSources(activeVideoId);
    setTimeline(updated);
    setCachedData(`tl-timeline:${activeVideoId}`, updated);
    const addedClip = updated.clips.find((candidate) => candidate.groupId === groupId);
    if (addedClip) {
      seekPreview(addedClip.startSeconds);
      playback.scrollTimelineToTime(addedClip.startSeconds);
    }
  }

  async function addGeneratedClipToTimeline(videoAssetId: string) {
    if (!activeVideoId) return;
    try {
      await refresh(projectsClient.addVideoAssetClipToStillsTrack(activeVideoId, videoAssetId, previewTime));
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  async function addLibraryAssetToTimeline(asset: { id: string; kind: "still" | "clip" | "audio" }) {
    if (!activeVideoId) return;
    try {
      if (asset.kind === "audio") {
        await refresh(projectsClient.addMusicClip(activeVideoId, asset.id, previewTime));
      } else {
        await refresh(projectsClient.addLibraryAssetToStillsTrack(activeVideoId, asset.id, previewTime));
      }
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  /** Places a multi-selected batch of Library assets onto a track back-to-back
   * in sequence, starting at `startSeconds` — each subsequent asset starts
   * right after the previous one's own duration. */
  async function placeBatchInSequence(items: { assetId: string; durationSeconds: number | null }[], startSeconds: number, track: "stills" | "music") {
    if (!activeVideoId) return;
    let cursor = startSeconds;
    for (const item of items) {
      try {
        const next = track === "music"
          ? await projectsClient.addMusicClip(activeVideoId, item.assetId, cursor)
          : await projectsClient.addLibraryAssetToStillsTrack(activeVideoId, item.assetId, cursor);
        setTimeline(next);
        setCachedData(`tl-timeline:${activeVideoId}`, next);
      } catch (caught) {
        addToast(String(caught), "error");
        break;
      }
      cursor += Math.max(0.5, item.durationSeconds ?? 3);
    }
  }

  function handleTrackDrop(track: "stills" | "music", event: React.DragEvent, dropSeconds: number) {
    const raw = event.dataTransfer.getData(MEDIA_DRAG_MIME);
    if (!raw || !activeVideoId) return;
    event.preventDefault();
    let payload: MediaDragPayload;
    try {
      payload = JSON.parse(raw) as MediaDragPayload;
    } catch {
      return;
    }
    if (payload.source === "video-asset") {
      if (track !== "stills") return;
      void refresh(projectsClient.addVideoAssetClipToStillsTrack(activeVideoId, payload.videoAssetId, Math.max(0, dropSeconds)));
      return;
    }
    if (payload.source === "media-library-batch") {
      if (payload.kind === "audio") {
        if (track !== "music") return;
        void placeBatchInSequence(payload.items, Math.max(0, dropSeconds), "music");
      } else {
        if (track !== "stills") return;
        void placeBatchInSequence(payload.items, Math.max(0, dropSeconds), "stills");
      }
      return;
    }
    if (payload.kind === "audio") {
      if (track !== "music") return;
      void refresh(projectsClient.addMusicClip(activeVideoId, payload.assetId, Math.max(0, dropSeconds)));
    } else {
      if (track !== "stills") return;
      void refresh(projectsClient.addLibraryAssetToStillsTrack(activeVideoId, payload.assetId, Math.max(0, dropSeconds)));
    }
  }

  async function resetEffects() {
    if (!activeVideoId || !selectedClip) return;
    const clipId = selectedClip.id;
    await refresh(projectsClient.setTimelineClipMotion(activeVideoId, clipId, "none"));
    await refresh(projectsClient.setTimelineClipTransition(activeVideoId, clipId, "cut"));
    await refresh(projectsClient.setTimelineClipTransitionOut(activeVideoId, clipId, "cut"));
    await refresh(projectsClient.setTimelineClipColorFilter(activeVideoId, clipId, "none", 50));
    await refresh(projectsClient.setTimelineClipMotionGraphic(activeVideoId, clipId, null, null, null));
  }

  async function swapRender(renderId: string) {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.setTimelineClipRender(activeVideoId, selectedClip.id, renderId));
  }

  async function setMotionRecipe(effect: string | null, settingsJson: string | null, reason: string | null) {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.setTimelineClipMotionGraphic(activeVideoId, selectedClip.id, effect, settingsJson, reason));
  }

  /** Discards any manual edit on the selected clip's Motion panel, restoring
   * exactly what Auto Motion originally composed for it (see
   * `motionGraphicAiSnapshotJson`'s doc comment) — MotionSettingsPanel only
   * ever shows the triggering button when that snapshot exists, but this
   * still surfaces a toast rather than throwing silently on the off chance
   * it's stale by the time the click lands. */
  async function resetMotionRecipeToAi() {
    if (!activeVideoId || !selectedClip) return;
    try {
      await refresh(projectsClient.resetTimelineClipMotionGraphicToAi(activeVideoId, selectedClip.id));
      addToast("Motion reset to what Auto Motion originally composed.", "success");
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  async function removeAllEffects() {
    if (!activeVideoId) return;
    await refresh(projectsClient.applyMotionToAllClips(activeVideoId, "none", globalIntensity));
    await refresh(projectsClient.applyTransitionInToAllClips(activeVideoId, "cut"));
    await refresh(projectsClient.applyTransitionOutToAllClips(activeVideoId, "cut"));
    await refresh(projectsClient.applyColorFilterToAllClips(activeVideoId, "none", 100));
    await refresh(projectsClient.clearMotionGraphicsForAllClips(activeVideoId));
    await refresh(projectsClient.resetStillsTimingToNatural(activeVideoId));
    addToast("Removed camera movement, transitions, color filters, motion graphics, and any gap-filling stretch from every still.", "success");
  }

  // Drives a full Auto Motion pass one batch (~5 clips) at a time, checking
  // motionControl between batches so it can be paused/resumed/stopped
  // whenever — the same shape as Bulk Generation's planning loop. Each
  // batch's clips are analyzed AND committed to the database by the backend
  // before this even sees the result (see analyze_motion_graphics_batch),
  // so pausing never loses or redoes work: resuming just calls the batch
  // command again, which only ever looks at clips that don't have a motion
  // treatment yet.
  async function runAutoMotionLoop() {
    if (!activeVideoId) return;
    motionControl.current = "running";
    setMotionStatus("running");
    setMotionGraphicsProgress(null);
    let pushedUndoPoint = false;
    try {
      while (motionControl.current === "running") {
        const result = await projectsClient.analyzeMotionGraphicsBatch(activeVideoId);
        setMotionGraphicsProgress({ done: result.completed, total: result.total });
        // Only the FIRST batch's refresh is undo-eligible — one "before
        // auto motion" checkpoint for the whole run, not one per batch.
        await refresh(projectsClient.getTimeline(activeVideoId), { skipHistory: pushedUndoPoint });
        pushedUndoPoint = true;
        if (result.done) {
          if (motionControl.current === "running") addToast(`Motion applied to ${result.total} still${result.total === 1 ? "" : "s"}.`, "success");
          motionControl.current = "stopped";
          break;
        }
      }
    } catch (caught) {
      addToast(String(caught), "error");
      motionControl.current = "paused";
    } finally {
      if (motionControl.current === "paused") {
        setMotionStatus("paused");
      } else {
        setMotionStatus(null);
        setMotionGraphicsProgress(null);
      }
    }
  }

  /** The toolbar button is a single control whose action depends on current
   * state: idle → start (via requestAutoMotion's confirm-if-overwriting
   * check), running → pause, paused → resume. */
  function toggleAutoMotion() {
    if (motionStatus === "running") {
      motionControl.current = "paused";
      setMotionStatus("paused");
    } else if (motionStatus === "paused") {
      void runAutoMotionLoop();
    } else {
      requestAutoMotion();
    }
  }

  function stopAutoMotion() {
    motionControl.current = "stopped";
    setMotionStatus(null);
    setMotionGraphicsProgress(null);
  }

  function requestAutoMotion() {
    const hasExistingEffects = stillsClips.some((clip) => clip.motionPreset !== "none" || clip.motionGraphicEffect);
    if (hasExistingEffects) {
      setConfirmAutoMotion(true);
      return;
    }
    void runAutoMotionLoop();
  }

  async function resetTimelineToDefault() {
    if (!activeVideoId || resettingTimeline) return;
    setResettingTimeline(true);
    try {
      setSelectedClip(null);
      setSelectedCaptionClip(null);
      await refresh(projectsClient.resetTimelineToDefault(activeVideoId));
      addToast("Timeline reset to its default order and settings.", "success");
    } finally {
      setResettingTimeline(false);
    }
  }

  async function extrapolateStills() {
    if (!activeVideoId || extrapolating) return;
    setExtrapolating(true);
    try {
      // Use ffmpeg's own measured duration (the same value export computes
      // video length from) rather than a browser-measured one, so extrapolated
      // stills always reach exactly as far as the exported audio/captions do.
      let duration = totalDuration;
      try {
        duration = await projectsClient.probeNarrationDuration(activeVideoId);
      } catch {
        // No narration audio yet, or the probe failed — fall back rather than
        // blocking the action entirely.
      }
      // Extrapolation can invalidate an already-assigned motion recipe (its
      // duration no longer matches what Auto Motion composed it for) — the
      // backend clears those clips' motion fields rather than leave a stale
      // recipe silently applied. Diff before/after so the user knows which
      // stills need Auto Motion re-run, rather than just seeing them go
      // quiet with no explanation.
      const previousMotion = new Map((timeline?.clips ?? []).map((clip) => [clip.id, clip.motionGraphicEffect]));
      const resultPromise = projectsClient.extrapolateStillsToFillGaps(activeVideoId, duration);
      await refresh(resultPromise);
      const updated = await resultPromise;
      const clearedCount = updated.clips.filter((clip) => previousMotion.get(clip.id) && !clip.motionGraphicEffect).length;
      addToast("Stills stretched to close every gap.", "success");
      if (clearedCount > 0) {
        addToast(
          `${clearedCount} still${clearedCount === 1 ? "" : "s"}' motion effect${clearedCount === 1 ? " was" : "s were"} cleared — duration${clearedCount === 1 ? "" : "s"} changed, re-run Auto motion.`,
          "info",
        );
      }
    } finally {
      setExtrapolating(false);
    }
  }

  async function runCaptionGeneration() {
    if (!activeVideoId) return;
    setGeneratingCaptions(true);
    setError(null);
    setCaptionProgress({ percent: 0, stage: "Preparing captions", detail: "" });
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = await listen<{ videoId: string; percent: number; stage: string; detail: string }>(
          "caption-progress",
          ({ payload }) => {
            if (payload.videoId === activeVideoId) {
              setCaptionProgress({ percent: payload.percent, stage: payload.stage, detail: payload.detail });
            }
          },
        );
      } catch {
        // Browser preview has no native event bridge.
      }
      const generated = await projectsClient.generateCaptions(activeVideoId, captionInterval);
      setCaptionSet(generated);
      setCachedData(`tl-captions:${activeVideoId}`, generated);
      // populate_timeline_from_sources only ADDS clips for chunk indices not
      // already on the timeline — a regenerate produces an entirely new set
      // of chunk indices/text/timings, so the old caption clips must be
      // cleared first or the new captions would either be skipped or
      // duplicated alongside stale ones.
      if (timeline && timeline.captionClips.length > 0) {
        await projectsClient.clearTimelineTrack(activeVideoId, "captions");
      }
      await refresh(projectsClient.populateTimelineFromSources(activeVideoId));
      setSelectedCaptionClip(null);
      addToast("Captions generated.", "success");
    } catch (caught) {
      setError(String(caught));
    } finally {
      unlisten?.();
      setGeneratingCaptions(false);
    }
  }

  function generateCaptions() {
    if (timeline && timeline.captionClips.length > 0) {
      setConfirmRegenerateCaptions(true);
      return;
    }
    void runCaptionGeneration();
  }

  async function saveCaptionsAs() {
    if (!captionSet) return;
    const safeTitle = (activeVideoTitle || "Video").replace(/[\\/:*?"<>|]/g, "").trim() || "Video";
    try {
      const path = await projectsClient.saveCaptionsFile(captionSet.srtText, `${safeTitle} Captions.srt`);
      if (path) addToast(`Captions saved to ${path}`, "success");
    } catch (caught) {
      setError(String(caught));
    }
  }

  function selectCaptionClip(clip: TimelineCaptionClipRecord) {
    setSelectedCaptionClip(clip);
    setSelectedMusicClip(null);
    setSelectedTrack(null);
    setActiveTool("captions");
  }

  function updateSelectedMusicClip(patch: Partial<{
    volumePercent: number; fadeInEnabled: boolean; fadeInSeconds: number;
    fadeOutEnabled: boolean; fadeOutSeconds: number; autoDuck: boolean; loopEnabled: boolean;
  }>) {
    if (!activeVideoId || !selectedMusicClip) return;
    void refresh(projectsClient.setMusicClipSettings(
      activeVideoId, selectedMusicClip.id,
      patch.volumePercent ?? selectedMusicClip.volumePercent,
      patch.fadeInEnabled ?? selectedMusicClip.fadeInEnabled,
      patch.fadeInSeconds ?? selectedMusicClip.fadeInSeconds,
      patch.fadeOutEnabled ?? selectedMusicClip.fadeOutEnabled,
      patch.fadeOutSeconds ?? selectedMusicClip.fadeOutSeconds,
      patch.autoDuck ?? selectedMusicClip.autoDuck,
      patch.loopEnabled ?? selectedMusicClip.loopEnabled,
    ));
  }

  function selectNarrationTrack() {
    setSelectedTrack("narration");
    setSelectedMusicClip(null);
    setSelectedTextClip(null);
    setSelectedCaptionClip(null);
    setActiveTool(null);
  }

  async function updateNarrationSettings(patch: Partial<{ volumePercent: number; trimStartSeconds: number; trimEndSeconds: number }>) {
    if (!activeVideoId || !timeline) return;
    await refresh(projectsClient.setNarrationSettings(
      activeVideoId,
      patch.volumePercent ?? timeline.narrationVolumePercent,
      patch.trimStartSeconds ?? timeline.narrationTrimStartSeconds,
      patch.trimEndSeconds ?? timeline.narrationTrimEndSeconds,
    ));
  }

  function handleSelectTool(tool: ToolKind | null) {
    setActiveTool(tool);
    if (tool !== "captions") setSelectedCaptionClip(null);
    if (tool !== "text") setSelectedTextClip(null);
    if (tool !== null) setSelectedMusicClip(null);
    if (tool !== null) setSelectedTrack(null);
  }

  async function commitCaptionText() {
    if (!activeVideoId || !selectedCaptionClip) return;
    const trimmed = captionText.trim();
    if (!trimmed || trimmed === selectedCaptionClip.text) return;
    await refresh(projectsClient.updateCaptionClipText(activeVideoId, selectedCaptionClip.id, trimmed));
  }

  async function deleteCaptionClip(clipOverride?: TimelineCaptionClipRecord) {
    const clip = clipOverride ?? selectedCaptionClip;
    if (!activeVideoId || !clip) return;
    await refresh(projectsClient.deleteTimelineCaptionClip(activeVideoId, clip.id));
    if (!clipOverride || clipOverride.id === selectedCaptionClip?.id) setSelectedCaptionClip(null);
  }

  async function splitCaptionClipAtPlayhead(clipOverride?: TimelineCaptionClipRecord) {
    const clip = clipOverride ?? selectedCaptionClip;
    if (!activeVideoId || !clip) return;
    const { startSeconds, endSeconds, text } = clip;
    if (previewTime <= startSeconds || previewTime >= endSeconds) return;
    const words = text.trim().split(/\s+/);
    if (words.length < 2) {
      addToast("This caption is too short to split — add more words first.", "error");
      return;
    }
    const fraction = (previewTime - startSeconds) / (endSeconds - startSeconds);
    const splitIndex = Math.max(1, Math.min(words.length - 1, Math.round(words.length * fraction)));
    const leftText = words.slice(0, splitIndex).join(" ");
    const rightText = words.slice(splitIndex).join(" ");
    await refresh(projectsClient.splitCaptionClip(activeVideoId, clip.id, previewTime, leftText, rightText));
  }

  async function mergeCaptionClipWithNext(clipOverride?: TimelineCaptionClipRecord) {
    const clip = clipOverride ?? selectedCaptionClip;
    if (!activeVideoId || !clip) return;
    const next = captionClips.find((candidate) => Math.abs(candidate.startSeconds - clip.endSeconds) < 0.01);
    if (!next) return;
    await refresh(projectsClient.mergeCaptionClips(activeVideoId, clip.id, next.id));
  }

  function openContextMenu(event: ReactMouseEvent, items: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }

  useEffect(() => { setDurationDraft(null); }, [selectedClip?.id]);

  async function commitClipDuration() {
    if (!activeVideoId || !selectedClip || durationDraft === null) return;
    const nextDuration = Number(durationDraft);
    setDurationDraft(null);
    if (!Number.isFinite(nextDuration) || nextDuration < 0.1) return;
    await refresh(projectsClient.updateTimelineClip(activeVideoId, selectedClip.id, selectedClip.startSeconds, selectedClip.startSeconds + nextDuration));
  }

  async function duplicateStillsClip(clip: TimelineClipRecord) {
    if (!activeVideoId) return;
    await refresh(projectsClient.duplicateTimelineClip(activeVideoId, clip.id));
  }

  async function removeStillsClip(clip: TimelineClipRecord) {
    if (!activeVideoId) return;
    await refresh(projectsClient.deleteTimelineClip(activeVideoId, clip.id));
    if (selectedClip?.id === clip.id) setSelectedClip(null);
  }

  function goToStillInVisuals(groupId: string) {
    if (activeVideoId) lastSelectedStill.set(activeVideoId, groupId);
    setStage("images");
  }

  async function addCaptionAtPlayhead() {
    if (!activeVideoId) return;
    try {
      const next = await projectsClient.addCaptionClip(activeVideoId, null, "New caption", previewTime);
      setCachedData(`tl-timeline:${activeVideoId}`, next);
      setTimeline(next);
      const added = next.captionClips.find((clip) => Math.abs(clip.startSeconds - previewTime) < 0.01 && clip.text === "New caption");
      if (added) selectCaptionClip(added);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function updateGlobalCaptionStyle(next: CaptionStyle) {
    if (!activeVideoId) return;
    await refresh(projectsClient.setTimelineCaptionStyle(activeVideoId, next));
  }

  async function updateSelectedCaptionStyle(next: CaptionStyle | null) {
    if (!activeVideoId || !selectedCaptionClip) return;
    await refresh(projectsClient.setCaptionClipStyle(activeVideoId, selectedCaptionClip.id, next));
  }

  // Every style-slider tick updates the pending draft synchronously (so the
  // canvas preview reacts immediately), while the actual backend commit — a
  // full timeline round-trip — is debounced so a fast drag doesn't fire one
  // request per pixel.
  function handleGlobalCaptionStyleChange(patch: Partial<CaptionStyle>) {
    const next: CaptionStyle = { ...effectiveGlobalCaptionStyle, ...patch };
    setPendingGlobalCaptionStyle(next);
    if (globalStyleCommitRef.current) window.clearTimeout(globalStyleCommitRef.current);
    globalStyleCommitRef.current = window.setTimeout(() => {
      void updateGlobalCaptionStyle(next).finally(() => setPendingGlobalCaptionStyle(undefined));
    }, 400);
  }

  function handleSelectedCaptionStyleChange(patch: Partial<CaptionStyle>) {
    if (!selectedCaptionClip) return;
    const base = pendingSelectedCaptionStyle !== undefined ? (pendingSelectedCaptionStyle ?? {}) : (selectedCaptionClip.style ?? {});
    const next: CaptionStyle = { ...base, ...patch };
    setPendingSelectedCaptionStyle(next);
    if (selectedStyleCommitRef.current) window.clearTimeout(selectedStyleCommitRef.current);
    selectedStyleCommitRef.current = window.setTimeout(() => {
      void updateSelectedCaptionStyle(next).finally(() => setPendingSelectedCaptionStyle(undefined));
    }, 400);
  }

  function resetSelectedCaptionStyle() {
    if (selectedStyleCommitRef.current) window.clearTimeout(selectedStyleCommitRef.current);
    setPendingSelectedCaptionStyle(null);
    void updateSelectedCaptionStyle(null).finally(() => setPendingSelectedCaptionStyle(undefined));
  }

  function resetGlobalCaptionStyle() {
    if (globalStyleCommitRef.current) window.clearTimeout(globalStyleCommitRef.current);
    setPendingGlobalCaptionStyle(DEFAULT_CAPTION_STYLE);
    void updateGlobalCaptionStyle(DEFAULT_CAPTION_STYLE).finally(() => setPendingGlobalCaptionStyle(undefined));
  }

  async function uploadAnimation() {
    if (!activeVideoId || !selectedClip || selectedClip.clipKind !== "still") return;
    setUploadingAnimation(true);
    setError(null);
    try {
      const next = await projectsClient.importAnimationClip(activeVideoId, selectedClip.id);
      if (!next) return; // user cancelled the file picker
      setCachedData(`tl-timeline:${activeVideoId}`, next);
      setTimeline(next);
      addToast("Animation uploaded and fitted to this clip's timeline slot.", "success");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setUploadingAnimation(false);
    }
  }

  async function adjustAnimationToDuration() {
    if (!activeVideoId || !selectedClip) return;
    setRetiming(true);
    setError(null);
    try {
      await refresh(projectsClient.retimeAnimationClip(activeVideoId, selectedClip.id));
      addToast("Animation stretched to fill its timeline slot.", "success");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setRetiming(false);
    }
  }

  async function undoAnimation() {
    if (!activeVideoId || !selectedClip) return;
    setError(null);
    try {
      await refresh(projectsClient.revertAnimationClipToStill(activeVideoId, selectedClip.id));
      addToast("Reverted to the still — the animation stays cached until you generate a new one.", "success");
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function restoreAnimation() {
    if (!activeVideoId || !selectedClip) return;
    setError(null);
    try {
      await refresh(projectsClient.restoreAnimationClip(activeVideoId, selectedClip.id));
      addToast("Cached animation restored.", "success");
    } catch (caught) {
      setError(String(caught));
    }
  }

  useEffect(() => {
    if (!exporting || !activeVideoId) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<{ videoId: string; percent: number; stage: string; detail: string }>("export-progress", ({ payload }) => {
          if (payload.videoId === activeVideoId) {
            setExportProgress({ percent: payload.percent, stage: payload.stage, detail: payload.detail });
          }
        });
      } catch {
        // Browser preview has no native event bridge.
      }
    })();
    return () => { unlisten?.(); };
  }, [exporting, activeVideoId]);

  async function startExport() {
    if (!activeVideoId) return;
    const sanitizedName = (exportFileName || activeVideoTitle || "video").replace(/[\\/:*?"<>|]+/g, " ").trim() || "video";
    const defaultName = `${sanitizedName}.mp4`;
    // The Preferences "Default save location" is a deliberate, explicit
    // choice — it should win over "wherever the last export happened to
    // land" so the dialog opens where the user actually told it to, letting
    // them just confirm the filename rather than navigate there again.
    // Falls back to the last-used export folder (e.g. Preferences was never
    // set) and finally to the OS's own default when neither is set.
    const [preferredFolder, rememberedFolder] = await Promise.all([
      projectsClient.getAppSetting("download_folder"),
      projectsClient.getAppSetting("export_last_folder"),
    ]);
    const destinationPath = await projectsClient.pickExportDestination(defaultName, preferredFolder || rememberedFolder);
    if (!destinationPath) return;
    const folder = destinationPath.slice(0, Math.max(destinationPath.lastIndexOf("/"), destinationPath.lastIndexOf("\\")));
    if (folder) await projectsClient.saveAppSetting("export_last_folder", folder);
    pausePreview();
    setExportKind("video");
    setExporting(true);
    setExportCancelling(false);
    setExportProgress({ percent: 0, stage: "Preparing export", detail: "" });
    setExportResult(null);
    setError(null);
    try {
      const savedPath = await projectsClient.exportTimelineVideo(activeVideoId, destinationPath, exportSettings);
      if (savedPath) setExportResult({ kind: "success", path: savedPath });
    } catch (caught) {
      setExportResult({ kind: "failure", error: String(caught) });
    } finally {
      setExporting(false);
      setExportCancelling(false);
      setExportKind(null);
    }
  }

  async function startExportProject() {
    if (!activeVideoId) return;
    const destinationPath = await projectsClient.pickExportProjectDestination();
    if (!destinationPath) return;
    pausePreview();
    setExportKind("project");
    setExporting(true);
    setExportCancelling(false);
    setExportProgress({ percent: 0, stage: "Preparing export", detail: "" });
    setError(null);
    try {
      const savedPath = await projectsClient.exportTimelineProject(activeVideoId, destinationPath);
      addToast(`Project assets exported to ${savedPath}`, "success");
      setConfirmExportProject(false);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setExporting(false);
      setExportCancelling(false);
      setExportKind(null);
    }
  }

  async function cancelExport() {
    if (!activeVideoId) return;
    setExportCancelling(true);
    await projectsClient.cancelTimelineExport(activeVideoId);
  }

  // Recomputes the "Saved Xm ago" titlebar label periodically — the value
  // itself is derived inline from timeline.updatedAt on every render, this
  // just forces those renders to keep happening while nothing else changes.
  useEffect(() => {
    const id = window.setInterval(() => setAutosaveTick((tick) => tick + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Editor-wide keyboard shortcuts. Guards focused text inputs the same way
  // ThumbnailEditor.tsx's shortcut handler does, so typing in a caption/text
  // field never triggers e.g. Space-to-play or Delete-removes-clip.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(document.activeElement)) return;
      const action = resolveShortcutAction(event);
      if (!action) return;
      event.preventDefault();

      switch (action.type) {
        case "toggleHelp":
          setShortcutsHelpOpen((current) => !current);
          return;
        case "closeTransient":
          if (contextMenu) { setContextMenu(null); return; }
          if (shortcutsHelpOpen) { setShortcutsHelpOpen(false); return; }
          setSelectedClip(null);
          setSelectedCaptionClip(null);
          setSelectedMusicClip(null);
          setSelectedTextClip(null);
          setSelectedTrack(null);
          setActiveTool(null);
          return;
        case "togglePlay":
          if (isPlaying) pausePreview(); else playPreview();
          return;
        case "seek":
          seekPreview(previewTimeRef.current + action.direction * FRAME_STEP_SECONDS);
          return;
        case "jumpClip":
          if (action.direction === -1) jumpToPreviousClip(); else jumpToNextClip();
          return;
        case "undo":
          void undo();
          return;
        case "redo":
          void redo();
          return;
        case "forceSave":
          addToast("Already saved — every change saves automatically.", "info");
          return;
        case "delete":
          if (!activeVideoId) return;
          if (selectedMusicClip) {
            void refresh(projectsClient.deleteMusicClip(activeVideoId, selectedMusicClip.id));
            setSelectedMusicClip(null);
          } else if (selectedTextClip) {
            void refresh(projectsClient.deleteTextOverlayClip(activeVideoId, selectedTextClip.id));
            setSelectedTextClip(null);
          } else if (selectedCaptionClip) {
            void deleteCaptionClip();
          } else if (selectedClip) {
            void refresh(projectsClient.deleteTimelineClip(activeVideoId, selectedClip.id));
          }
          return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoId, isPlaying, selectedMusicClip, selectedTextClip, selectedCaptionClip, selectedClip, timeline, contextMenu, shortcutsHelpOpen]);

  // The Editor owns the titlebar's right-side actions (Export video + the ⋯
  // overflow menu) since the titlebar itself has no per-page context — set
  // it on mount/update, clear it on unmount so other tabs don't inherit it.
  const hasClips = Boolean(timeline?.clips.length);
  useEffect(() => {
    setTitlebarActions(
      <div className="tl-titlebar-actions">
        <span className={savingCount > 0 ? "tl-autosave-indicator saving" : "tl-autosave-indicator"}>
          {savingCount > 0 ? "Saving…" : timeline ? formatSavedRelativeTime(timeline.updatedAt) : ""}
        </span>
        <div className="tl-titlebar-menu-wrap">
          <button className="titlebar-action-btn" onClick={() => setTitlebarMenuOpen((current) => !current)} aria-label="More actions">
            <MoreHorizontal size={16} />
          </button>
          {titlebarMenuOpen && (
            <div className="titlebar-menu" onMouseLeave={() => setTitlebarMenuOpen(false)}>
              <button disabled={!hasClips} onClick={() => { setTitlebarMenuOpen(false); setConfirmExportProject(true); }}>
                <Sparkles size={13} />Export project
              </button>
              <button onClick={() => { setTitlebarMenuOpen(false); setConfirmResetTimeline(true); }}><Undo2 size={13} />Reset timeline to default</button>
              <button onClick={() => { setTitlebarMenuOpen(false); setConfirmRemoveAllEffects(true); }}><Trash2 size={13} />Remove all effects</button>
              <button
                disabled={!timeline}
                onClick={() => {
                  setTitlebarMenuOpen(false);
                  if (activeVideoId && timeline) void refresh(projectsClient.setSequenceLocked(activeVideoId, !timeline.sequenceLocked));
                }}
              >
                <Lock size={13} />{timeline?.sequenceLocked ?? true ? "Unlock sequence" : "Lock sequence"}
              </button>
              <button onClick={() => { setTitlebarMenuOpen(false); setShortcutsHelpOpen(true); }}><Keyboard size={13} />Keyboard shortcuts</button>
              <button onClick={() => { setTitlebarMenuOpen(false); setExportHistoryOpen(true); }}><Clock size={13} />Export history</button>
            </div>
          )}
        </div>
        <button className="titlebar-action-btn primary" disabled={!hasClips} onClick={() => setExportDrawerOpen(true)}>
          <Download size={14} />Export video
        </button>
      </div>,
    );
    return () => setTitlebarActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titlebarMenuOpen, hasClips, savingCount, timeline?.updatedAt, timeline?.sequenceLocked, autosaveTick]);

  if (!activeVideoId) {
    return <section className="view timeline-view"><div className="empty-state">Open a video first.</div></section>;
  }
  if (loading) {
    return <section className="view timeline-view"><div className="empty-state">Loading timeline…</div></section>;
  }
  if (error && !timeline) {
    return <section className="view timeline-view"><div className="inline-error">{error}</div></section>;
  }
  if (!timeline) {
    return <section className="view timeline-view"><div className="empty-state">Loading timeline…</div></section>;
  }

  return (
    <section className="view timeline-view">
      <div className="page-heading">
        <div>
          <h1>Editor</h1>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {confirmExportProject && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmExportProject(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Export</p>
            <h2>Export project</h2>
            <ul className="tl-export-bullets">
              <li><strong>Export video</strong> — a single, ready-to-upload MP4.</li>
              <li><strong>Export project</strong> — separate assets for an external editor (CapCut, Premiere, etc).</li>
            </ul>
            <p className="tl-source-hint">Includes: every still/animation as its own trimmed clip file, narration audio, and captions — each preserving this timeline's exact durations. You'll choose a destination folder next.</p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmExportProject(false)}>Cancel</button>
              <button className="primary" onClick={() => void startExportProject()}><Play size={15} />Start export</button>
            </div>
          </section>
        </div>
      )}
      {exporting && exportKind === "project" && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card generation-progress">
            <div className="progress-heading">
              <LoaderCircle className="spin" size={26} />
              <strong>{exportCancelling ? "Cancelling…" : exportProgress.stage}</strong>
              {!exportCancelling && <b>{Math.max(0, Math.min(100, exportProgress.percent))}%</b>}
            </div>
            <span>{exportCancelling ? "Stopping the export engine…" : (exportProgress.detail || "Starting the export engine…")}</span>
            <div className="loading-bar determinate"><i style={{ width: `${exportProgress.percent}%` }} /></div>
            <button className="secondary" style={{ marginTop: "14px" }} disabled={exportCancelling} onClick={() => void cancelExport()}><Square size={13} />{exportCancelling ? "Cancelling…" : "Stop"}</button>
          </div>
        </div>
      )}
      {confirmResetTimeline && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmResetTimeline(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Reset timeline</p>
            <h2>Reset timeline to default?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This will discard all customisation — clip order, timing, camera movement, transitions, caption edits
              and styles, and audio settings — and rebuild the timeline from scratch. This can't be undone.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmResetTimeline(false)}>Cancel</button>
              <button className="primary danger" onClick={() => { setConfirmResetTimeline(false); void resetTimelineToDefault(); }}>Reset</button>
            </div>
          </section>
        </div>
      )}
      {confirmRemoveAllEffects && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmRemoveAllEffects(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Remove all effects</p>
            <h2>Remove all effects?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This will remove all camera movement, motion graphics, transitions, and colour filters from every
              clip, and undo any gap-filling stretch. This cannot be undone.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmRemoveAllEffects(false)}>Cancel</button>
              <button className="primary danger" onClick={() => { setConfirmRemoveAllEffects(false); void removeAllEffects(); }}>Remove all effects</button>
            </div>
          </section>
        </div>
      )}
      {confirmExtrapolateStills && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmExtrapolateStills(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Fill gaps</p>
            <h2>Fill timeline gaps?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This will stretch every still to close gaps between clips. Clip durations will change.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmExtrapolateStills(false)}>Cancel</button>
              <button className="primary danger" onClick={() => { setConfirmExtrapolateStills(false); void extrapolateStills(); }}>Fill gaps</button>
            </div>
          </section>
        </div>
      )}
      {confirmAutoMotion && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmAutoMotion(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Auto motion</p>
            <h2>Apply auto motion to all stills?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This will overwrite any existing camera movement or motion graphics on every clip.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmAutoMotion(false)}>Cancel</button>
              <button className="primary" onClick={() => { setConfirmAutoMotion(false); void runAutoMotionLoop(); }}>Apply auto motion</button>
            </div>
          </section>
        </div>
      )}
      {shortcutsHelpOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShortcutsHelpOpen(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Keyboard shortcuts</p>
            <h2>Editor shortcuts</h2>
            <ul className="tl-shortcuts-list">
              <li><kbd>Space</kbd><span>Play / pause</span></li>
              <li><kbd>←</kbd> / <kbd>→</kbd><span>Move playhead one frame</span></li>
              <li><kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd><span>Jump to previous / next clip</span></li>
              <li><kbd>Ctrl/Cmd</kbd>+<kbd>Z</kbd><span>Undo</span></li>
              <li><kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd><span>Redo</span></li>
              <li><kbd>Ctrl/Cmd</kbd>+<kbd>S</kbd><span>Force save</span></li>
              <li><kbd>Delete</kbd> / <kbd>Backspace</kbd><span>Remove selected clip</span></li>
              <li><kbd>Esc</kbd><span>Clear selection / close this dialog</span></li>
              <li><kbd>?</kbd><span>Toggle this help</span></li>
            </ul>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setShortcutsHelpOpen(false)}>Close</button>
            </div>
          </section>
        </div>
      )}
      {confirmRegenerateCaptions && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmRegenerateCaptions(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Regenerate captions</p>
            <h2>Discard existing caption edits?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              Regenerating rebuilds the caption track from scratch — any retiming, text edits, splits, merges, or per-clip
              style overrides you've made on the current captions will be lost.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmRegenerateCaptions(false)}>Cancel</button>
              <button className="primary danger" onClick={() => { setConfirmRegenerateCaptions(false); void runCaptionGeneration(); }}>Regenerate</button>
            </div>
          </section>
        </div>
      )}
      {generatingCaptions && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card generation-progress">
            <div className="progress-heading">
              <LoaderCircle className="spin" size={26} />
              <strong>{captionProgress.stage}</strong>
              <b>{captionProgress.percent}%</b>
            </div>
            <span>{captionProgress.detail || "Starting the local caption engine…"}</span>
            <div className="loading-bar determinate"><i style={{ width: `${captionProgress.percent}%` }} /></div>
          </div>
        </div>
      )}
      <>
        <div className="tl-workspace">
          <MediaLibraryPanel
            videoId={activeVideoId}
            workspace={workspace}
            renderUrls={renderUrls}
            timelineUpdatedAt={timeline.updatedAt}
            onJumpToStill={(groupId) => void selectStillInSource(groupId)}
            onAddGeneratedClip={(videoAssetId) => void addGeneratedClipToTimeline(videoAssetId)}
            onAddLibraryAsset={(asset) => void addLibraryAssetToTimeline(asset)}
            addToast={addToast}
          />
          <TimelinePreview hasStillsClips={stillsClips.length > 0} canvasRef={previewCanvasRef} canvasSize={canvasSize} />
          <aside className="tl-inspector-pane">
            {activeTool === "captions" && (
              <CaptionsInspector
                selectedCaptionClip={selectedCaptionClip}
                captionClips={captionClips}
                captionText={captionText}
                onCaptionTextChange={setCaptionText}
                onCommitCaptionText={() => void commitCaptionText()}
                previewTime={previewTime}
                onSplitAtPlayhead={() => void splitCaptionClipAtPlayhead()}
                onMergeWithNext={() => void mergeCaptionClipWithNext()}
                onDeleteCaption={() => void deleteCaptionClip()}
                onBack={() => setSelectedCaptionClip(null)}
                onSelectCaption={(clip) => { selectCaptionClip(clip); seekPreview(clip.startSeconds); }}
                effectiveSelectedCaptionStyle={effectiveSelectedCaptionStyle}
                effectiveGlobalCaptionStyle={effectiveGlobalCaptionStyle}
                onSelectedStyleChange={handleSelectedCaptionStyleChange}
                onResetSelectedStyle={resetSelectedCaptionStyle}
                captionSet={captionSet}
                generatingCaptions={generatingCaptions}
                onGenerateCaptions={generateCaptions}
                onSaveCaptionsAs={() => void saveCaptionsAs()}
                onAddCaptionAtPlayhead={() => void addCaptionAtPlayhead()}
                onGlobalStyleChange={handleGlobalCaptionStyleChange}
                onResetGlobalStyle={resetGlobalCaptionStyle}
              />
            )}
            {!activeTool && selectedMusicClip && (
              <div className="tl-inspector">
                <div className="tl-inspector-header">
                  <button className="tl-apply-all-btn" style={{ alignSelf: "flex-start" }} onClick={() => setSelectedMusicClip(null)}>← Back</button>
                  <strong><Sparkles size={14} />Audio clip</strong>
                  <span>{formatTime(selectedMusicClip.startSeconds)} – {formatTime(selectedMusicClip.endSeconds)}</span>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">File name</span>
                  <p className="tl-source-hint">{selectedMusicClip.label}</p>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Volume</span>
                  <div className="tl-intensity-control">
                    <input
                      type="range" className="tl-slider" min={0} max={200} step={1}
                      value={selectedMusicClip.volumePercent}
                      onChange={(event) => updateSelectedMusicClip({ volumePercent: Number(event.target.value) })}
                    />
                    <span className="tl-intensity-value">{Math.round(selectedMusicClip.volumePercent)}%</span>
                  </div>
                </div>
                <div className="tl-inspector-group">
                  <label className="tl-checkbox-row">
                    <input type="checkbox" checked={selectedMusicClip.fadeInEnabled} onChange={(event) => updateSelectedMusicClip({ fadeInEnabled: event.target.checked })} />
                    <span>Fade in</span>
                  </label>
                  {selectedMusicClip.fadeInEnabled && (
                    <input
                      type="number" className="tl-slider-number" min={0} max={30} step={0.5}
                      value={selectedMusicClip.fadeInSeconds}
                      onChange={(event) => updateSelectedMusicClip({ fadeInSeconds: Number(event.target.value) })}
                    />
                  )}
                </div>
                <div className="tl-inspector-group">
                  <label className="tl-checkbox-row">
                    <input type="checkbox" checked={selectedMusicClip.fadeOutEnabled} onChange={(event) => updateSelectedMusicClip({ fadeOutEnabled: event.target.checked })} />
                    <span>Fade out</span>
                  </label>
                  {selectedMusicClip.fadeOutEnabled && (
                    <input
                      type="number" className="tl-slider-number" min={0} max={30} step={0.5}
                      value={selectedMusicClip.fadeOutSeconds}
                      onChange={(event) => updateSelectedMusicClip({ fadeOutSeconds: Number(event.target.value) })}
                    />
                  )}
                </div>
                <div className="tl-inspector-group">
                  <label className="tl-checkbox-row">
                    <input type="checkbox" checked={selectedMusicClip.autoDuck} onChange={(event) => updateSelectedMusicClip({ autoDuck: event.target.checked })} />
                    <span>Auto-duck under voiceover</span>
                  </label>
                </div>
                <div className="tl-inspector-group">
                  <label className="tl-checkbox-row">
                    <input type="checkbox" checked={selectedMusicClip.loopEnabled} onChange={(event) => updateSelectedMusicClip({ loopEnabled: event.target.checked })} />
                    <span>Loop if shorter than the video</span>
                  </label>
                </div>
                <div className="tl-inspector-actions">
                  <button className="secondary danger-action" onClick={() => { void refresh(projectsClient.deleteMusicClip(activeVideoId, selectedMusicClip.id)); setSelectedMusicClip(null); }}>
                    <Trash2 size={14} />Delete clip
                  </button>
                </div>
              </div>
            )}
            {!activeTool && !selectedMusicClip && selectedTrack === "narration" && timeline && (
              <div className="tl-inspector">
                <div className="tl-inspector-header">
                  <button className="tl-apply-all-btn" style={{ alignSelf: "flex-start" }} onClick={() => setSelectedTrack(null)}>← Back</button>
                  <strong><Sparkles size={14} />Narration</strong>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Volume</span>
                  <div className="tl-intensity-control">
                    <input
                      type="range" className="tl-slider" min={0} max={200} step={1}
                      value={timeline.narrationVolumePercent}
                      onChange={(event) => void updateNarrationSettings({ volumePercent: Number(event.target.value) })}
                    />
                    <span className="tl-intensity-value">{Math.round(timeline.narrationVolumePercent)}%</span>
                  </div>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Trim start</span>
                  <input
                    type="number" className="tl-slider-number" min={0} step={0.1}
                    value={timeline.narrationTrimStartSeconds}
                    onChange={(event) => void updateNarrationSettings({ trimStartSeconds: Math.max(0, Number(event.target.value)) })}
                  />
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Trim end</span>
                  <input
                    type="number" className="tl-slider-number" min={0} step={0.1}
                    value={timeline.narrationTrimEndSeconds}
                    onChange={(event) => void updateNarrationSettings({ trimEndSeconds: Math.max(0, Number(event.target.value)) })}
                  />
                </div>
              </div>
            )}
            {!activeTool && !selectedMusicClip && !(selectedTrack === "narration") && (selectedClip ? (
              <ClipInspector
                selectedClip={selectedClip}
                selectedClipRenders={selectedClipRenders}
                durationDraft={durationDraft}
                onDurationDraftChange={setDurationDraft}
                onCommitDuration={() => void commitClipDuration()}
                selectedClipVideoAsset={selectedClipVideoAsset}
                onUploadAnimation={() => void uploadAnimation()}
                uploadingAnimation={uploadingAnimation}
                onUndoAnimation={() => void undoAnimation()}
                onRestoreAnimation={() => void restoreAnimation()}
                onAdjustAnimationToDuration={() => void adjustAnimationToDuration()}
                retiming={retiming}
                onSwapRender={(renderId) => void swapRender(renderId)}
                onMotionRecipeChange={(effect, settingsJson, reason) => void setMotionRecipe(effect, settingsJson, reason)}
                onResetMotionRecipeToAi={() => void resetMotionRecipeToAi()}
              />
            ) : (
              <div className="tl-inspector-empty">
                <Move size={22} />
                <p>Select a clip or audio in the timeline, or choose a tool above to get started.</p>
              </div>
            ))}
            {activeTool === "text" && (
              <TextOverlayTool
                videoId={activeVideoId}
                timeline={timeline}
                selectedTextClip={selectedTextClip}
                playheadSeconds={previewTime}
                onSelectClip={setSelectedTextClip}
                refresh={refresh}
                addToast={addToast}
                focusRequestId={textOverlayFocusRequestId}
              />
            )}
            {activeTool === "music" && (
              <MusicTool videoId={activeVideoId} timeline={timeline} playheadSeconds={previewTime} refresh={refresh} addToast={addToast} />
            )}
            {activeTool === "motion" && (
              <MotionTool videoId={activeVideoId} timeline={timeline} refresh={refresh} addToast={addToast} />
            )}
          </aside>
        </div>
        <div className="tl-timeline-pane">
          {!timeline.sequenceLocked && (
            <div className="tl-lock-banner">Sequence unlocked — clips are no longer synced to narration.</div>
          )}
          <PlaybackControls
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={() => void undo()}
            onRedo={() => void redo()}
            previewTime={previewTime}
            totalDuration={totalDuration}
            isPlaying={isPlaying}
            onTogglePlay={() => (isPlaying ? pausePreview() : playPreview())}
            hasStillsClips={stillsClips.length > 0}
            onJumpPreviousClip={jumpToPreviousClip}
            onJumpNextClip={jumpToNextClip}
            onStepBackward={stepBackward}
            onStepForward={stepForward}
          />
          <Toolbar
            activeTool={activeTool}
            onSelectTool={handleSelectTool}
            onExtrapolateStills={() => setConfirmExtrapolateStills(true)}
            extrapolating={extrapolating}
            hasSelectedClip={Boolean(selectedClip)}
            onRemoveThisClipEffects={() => void resetEffects()}
            onRemoveAllEffects={() => setConfirmRemoveAllEffects(true)}
            onAnalyzeMotionGraphics={toggleAutoMotion}
            onStopAutoMotion={stopAutoMotion}
            analyzingMotionGraphics={motionStatus !== null}
            motionGraphicsPaused={motionStatus === "paused"}
            motionGraphicsProgressLabel={motionGraphicsProgress ? (motionStatus === "paused" ? `Paused ${motionGraphicsProgress.done} / ${motionGraphicsProgress.total}` : `Applying motion… ${motionGraphicsProgress.done} / ${motionGraphicsProgress.total}`) : null}
            aspectRatio={aspectRatio}
            onAspectRatioChange={(ratio) => void handleAspectRatioChange(ratio)}
          />
          <TimelineTracks
            pixelsPerSecond={pixelsPerSecond}
            totalWidthPx={totalWidthPx}
            playheadPx={playheadPx}
            previewTime={previewTime}
            audioDataUrl={audioDataUrl}
            waveformCanvasRef={waveformCanvasRef}
            onNarrationDuration={setNarrationDuration}
            narrationOffsetSeconds={timeline.narrationOffsetSeconds}
            selectedTrack={selectedTrack}
            onSelectNarrationTrack={selectNarrationTrack}
            onBeginPlayheadDrag={drag.beginPlayheadDrag}
            stillsClips={stillsClips}
            stillsDragPreview={drag.stillsDragPreview}
            renderUrls={renderUrls}
            mediaAssetUrls={mediaAssetUrls}
            selectedClipId={selectedClip?.id ?? null}
            sequenceLocked={timeline.sequenceLocked}
            onBeginStillsDrag={drag.beginStillsDrag}
            onSelectStillsClip={(_clip, atSeconds) => { setSelectedTrack(null); seekPreview(atSeconds); }}
            onDuplicateStillsClip={(clip) => void duplicateStillsClip(clip)}
            onRemoveStillsClip={(clip) => void removeStillsClip(clip)}
            onGoToStillInVisuals={goToStillInVisuals}
            captionClips={captionClips}
            captionDragPreview={drag.captionDragPreview}
            selectedCaptionClipId={selectedCaptionClip?.id ?? null}
            snapIndicatorSeconds={drag.snapIndicatorSeconds}
            onBeginCaptionDrag={drag.beginCaptionDrag}
            onSeek={seekPreview}
            onSelectCaptionAndSeek={(clip) => { selectCaptionClip(clip); seekPreview(clip.startSeconds); }}
            onOpenCaptionsTool={() => setActiveTool("captions")}
            onOpenContextMenu={openContextMenu}
            onSplitCaptionAtPlayhead={(clip) => void splitCaptionClipAtPlayhead(clip)}
            onMergeCaptionWithNext={(clip) => void mergeCaptionClipWithNext(clip)}
            onDeleteCaptionClip={(clip) => void deleteCaptionClip(clip)}
            onEditCaptionClip={(clip) => { selectCaptionClip(clip); seekPreview(clip.startSeconds); }}
            onDeselectTrack={() => setSelectedTrack(null)}
            onDropOnTrack={handleTrackDrop}
            onDragPointerMove={drag.onDragPointerMove}
            onEndDrag={drag.endDrag}
            onCanvasWheel={onCanvasWheel}
            canvasScrollRef={canvasScrollRef}
            canvasInnerRef={canvasInnerRef}
          />
        </div>
      </>
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
      <ExportDrawer
        open={exportDrawerOpen}
        onClose={() => { setExportDrawerOpen(false); setExportResult(null); }}
        hasClips={Boolean(timeline.clips.length)}
        hasMusic={Boolean(timeline.musicClips.length)}
        exporting={exporting && exportKind === "video"}
        exportCancelling={exportCancelling}
        exportProgress={exportProgress}
        settings={exportSettings}
        onSettingsChange={(patch) => setExportSettings((current) => ({ ...current, ...patch }))}
        fileName={exportFileName}
        onFileNameChange={setExportFileName}
        result={exportResult}
        onStart={() => void startExport()}
        onCancel={() => void cancelExport()}
        onExportAgain={() => { setExportResult(null); void startExport(); }}
        onShowInFolder={(path) => void projectsClient.revealInFileManager(path)}
        onOpenHistory={() => setExportHistoryOpen(true)}
      />
      {exportHistoryOpen && activeVideoId && (
        <ExportHistoryModal videoId={activeVideoId} onClose={() => setExportHistoryOpen(false)} />
      )}
      <audio
        ref={audioRef}
        src={audioDataUrl ?? undefined}
        style={{ display: "none" }}
        onEnded={() => pausePreview()}
        onLoadedMetadata={(event) => setNativeAudioDuration(event.currentTarget.duration || 0)}
      />
    </section>
  );
}

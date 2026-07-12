import {
  Clapperboard,
  Clock,
  Download,
  ImageOff,
  LoaderCircle,
  Minus,
  Move,
  Pause,
  Play,
  Plus,
  Redo2,
  Scissors,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAppStore } from "./store/app-store";
import { formatTime, pixelsToSeconds, secondsToPixels } from "./domain/timecode";
import { pickVeoDuration } from "./domain/animation";
import { getCachedData, resolveAssetUrl, resolveRenderUrl, resolveVideoAssetUrl, setCachedData } from "./infrastructure/media-cache";
import {
  projectsClient,
  type AnimationJobRecord,
  type CaptionSetRecord,
  type ImageRenderRecord,
  type ImageWorkspaceRecord,
  type MotionPreset,
  type TimelineClipRecord,
  type TimelineRecord,
  type VeoResolution,
  type VideoAssetRecord,
} from "./infrastructure/projects-client";

const BASE_PIXELS_PER_SECOND = 40;
const NARRATION_LANE_HEIGHT = 40;
const STILLS_LANE_HEIGHT = 96;
const CAPTIONS_LANE_HEIGHT = 40;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

const MOTION_OPTIONS: { value: MotionPreset; label: string; icon: typeof Move }[] = [
  { value: "zoom-in", label: "Zoom in", icon: ZoomIn },
  { value: "zoom-out", label: "Zoom out", icon: ZoomOut },
];

function motionLabel(preset: MotionPreset): string {
  return MOTION_OPTIONS.find((option) => option.value === preset)?.label ?? "None";
}

// Matches the export engine: `intensity` is the total zoom/pan amount over
// REFERENCE_DURATION seconds, applied as a constant per-second rate to every
// clip so the effect feels equally fast regardless of a still's own duration.
const MOTION_REFERENCE_DURATION = 5.0;

function applyMotion(
  motion: MotionPreset,
  elapsedSeconds: number,
  duration: number,
  intensity: number,
  rect: { x: number; y: number; w: number; h: number },
) {
  if (motion === "none") return rect;
  const amount = Math.max(0.02, Math.min(0.6, intensity));
  const rate = amount / MOTION_REFERENCE_DURATION;
  const maxScale = 1 + amount * 3;
  const peak = 1 + amount;
  let scaleMul = 1;
  let panX = 0.5;
  const panY = 0.5;
  if (motion === "zoom-in") {
    scaleMul = Math.min(maxScale, 1 + rate * elapsedSeconds);
  } else if (motion === "zoom-out") {
    scaleMul = Math.min(maxScale, 1 + rate * (duration - elapsedSeconds));
  } else if (motion === "pan-left") {
    scaleMul = peak;
    panX = 1 - Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
  } else if (motion === "pan-right") {
    scaleMul = peak;
    panX = Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
  }
  const w = rect.w * scaleMul;
  const h = rect.h * scaleMul;
  return { x: rect.x - (w - rect.w) * panX, y: rect.y - (h - rect.h) * panY, w, h };
}

// Matches the export engine's fade window: `min(0.5, duration / 2)` seconds
// of fade-from/to-black at the start/end of the clip.
function fadeOverlayAlpha(
  transitionIn: string,
  transitionOut: string,
  elapsedSeconds: number,
  duration: number,
): number {
  const fadeDuration = Math.min(0.5, duration / 2);
  if (fadeDuration <= 0) return 0;
  let alpha = 0;
  if (transitionIn === "fade" && elapsedSeconds < fadeDuration) {
    alpha = Math.max(alpha, 1 - elapsedSeconds / fadeDuration);
  }
  const timeFromEnd = duration - elapsedSeconds;
  if (transitionOut === "fade" && timeFromEnd < fadeDuration) {
    alpha = Math.max(alpha, 1 - timeFromEnd / fadeDuration);
  }
  return Math.max(0, Math.min(1, alpha));
}

export function TimelineView() {
  const { activeVideoId, activeVideoTitle, addToast } = useAppStore();
  const [timeline, setTimeline] = useState<TimelineRecord | null>(null);
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [captionSet, setCaptionSet] = useState<CaptionSetRecord | null>(null);
  const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [narrationDuration, setNarrationDuration] = useState(0);
  const [nativeAudioDuration, setNativeAudioDuration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<TimelineClipRecord | null>(null);
  const [selectedClipRenders, setSelectedClipRenders] = useState<ImageRenderRecord[]>([]);
  const [exportModal, setExportModal] = useState<"video" | "project" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ percent: 0, stage: "Preparing export", detail: "" });
  const [canvasSize, setCanvasSize] = useState({ width: 960, height: 540 });
  const [previewTime, setPreviewTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [sourceTab, setSourceTab] = useState<"stills" | "animations">("stills");
  const [inspectorTab, setInspectorTab] = useState<"clip" | "global">("clip");
  const [globalIntensity, setGlobalIntensity] = useState(0.22);
  const [videoAssetUrls, setVideoAssetUrls] = useState<Record<string, string>>({});
  const [animationResolution, setAnimationResolution] = useState<VeoResolution>("720p");
  const [animationPrompt, setAnimationPrompt] = useState("");
  const [suggestingPrompt, setSuggestingPrompt] = useState(false);
  const [animationJob, setAnimationJob] = useState<AnimationJobRecord | null>(null);
  const [selectedClipVideoAsset, setSelectedClipVideoAsset] = useState<VideoAssetRecord | null>(null);
  const [retiming, setRetiming] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const activeVideoElRef = useRef<HTMLVideoElement | null>(null);
  const activeAnimationAssetIdRef = useRef<string | null>(null);
  const previewTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playStartRef = useRef<{ wallStart: number; timeStart: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawFrameRef = useRef<(time: number) => void>(() => {});
  const canvasInnerRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const stillsClipsRef = useRef<TimelineClipRecord[]>([]);
  const playheadDragRef = useRef(false);

  useEffect(() => {
    if (!activeVideoId) return;
    let cancelled = false;
    setError(null);
    setSelectedClip(null);

    // Stale-while-revalidate: show whatever we already have for this video
    // instantly (no spinner flash on every tab switch), then refresh quietly.
    const cachedWorkspace = getCachedData<ImageWorkspaceRecord>(`tl-workspace:${activeVideoId}`);
    const cachedTimeline = getCachedData<TimelineRecord>(`tl-timeline:${activeVideoId}`);
    const cachedCaptions = getCachedData<CaptionSetRecord | null>(`tl-captions:${activeVideoId}`);
    if (cachedWorkspace) setWorkspace(cachedWorkspace);
    if (cachedTimeline) setTimeline(cachedTimeline);
    if (cachedCaptions !== undefined) setCaptionSet(cachedCaptions);
    setLoading(!cachedWorkspace || !cachedTimeline);

    (async () => {
      try {
        const [loadedWorkspace, inputs] = await Promise.all([
          projectsClient.getImageWorkspace(activeVideoId),
          projectsClient.getVideoInputs(activeVideoId),
        ]);
        if (cancelled) return;
        setCachedData(`tl-workspace:${activeVideoId}`, loadedWorkspace);
        setWorkspace(loadedWorkspace);
        if (inputs.audio) void resolveAssetUrl(inputs.audio.id).then((url) => { if (!cancelled) setAudioDataUrl(url); });
        try {
          const captions = await projectsClient.getCaptions(activeVideoId);
          if (!cancelled) {
            setCachedData(`tl-captions:${activeVideoId}`, captions);
            setCaptionSet(captions);
          }
        } catch {
          if (!cancelled) {
            setCachedData<CaptionSetRecord | null>(`tl-captions:${activeVideoId}`, null);
            setCaptionSet(null);
          }
        }
        let loadedTimeline: TimelineRecord;
        try {
          loadedTimeline = await projectsClient.getTimeline(activeVideoId);
        } catch {
          loadedTimeline = await projectsClient.populateTimelineFromSources(activeVideoId);
        }
        if (!cancelled) {
          setCachedData(`tl-timeline:${activeVideoId}`, loadedTimeline);
          setTimeline(loadedTimeline);
        }
      } catch (caught) {
        if (!cancelled) setError(String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeVideoId]);

  useEffect(() => {
    const ids = (workspace?.groups ?? []).map((group) => group.imageRenders[0]?.id).filter(Boolean) as string[];
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [workspace, renderUrls]);

  useEffect(() => {
    const renderIds = (timeline?.clips ?? []).map((clip) => clip.renderId).filter(Boolean) as string[];
    void Promise.all(renderIds.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [timeline, renderUrls]);

  useEffect(() => {
    const videoAssetIds = (timeline?.clips ?? []).map((clip) => clip.videoAssetId).filter(Boolean) as string[];
    void Promise.all(videoAssetIds.filter((id) => !videoAssetUrls[id]).map(async (id) => {
      const url = await resolveVideoAssetUrl(id);
      setVideoAssetUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [timeline, videoAssetUrls]);

  useEffect(() => {
    if (!selectedClip || !activeVideoId) {
      setSelectedClipRenders([]);
      return;
    }
    void projectsClient.listImageRenders(activeVideoId, selectedClip.groupId).then(setSelectedClipRenders).catch(() => setSelectedClipRenders([]));
  }, [selectedClip, activeVideoId]);

  // Clear any typed/suggested animation prompt when the selection moves to a
  // different clip — a prompt written for one still shouldn't silently apply
  // to the next one the user picks.
  useEffect(() => {
    setAnimationPrompt("");
  }, [selectedClip?.id]);

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
  const stillsClips = [...(timeline?.clips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
  const captionClips = captionSet?.chunks ?? [];
  const playheadPx = secondsToPixels(previewTime, pixelsPerSecond);
  stillsClipsRef.current = stillsClips;

  // Same leading-gap handling as the export engine: a small silence before
  // the first still (start > 0) should still show that still, not black —
  // whatever time is asked for before the first clip's nominal start just
  // renders as that clip. Matches the export always opening on the first
  // still (see build_timeline_export_manifest), so preview and export agree.
  function findClipAtTime(clips: TimelineClipRecord[], time: number): TimelineClipRecord | undefined {
    const first = clips[0];
    if (first && time < first.startSeconds) return first;
    return clips.find((c) => time >= c.startSeconds && time < c.endSeconds);
  }

  function updateSelectionForTime(time: number) {
    const clip = findClipAtTime(stillsClipsRef.current, time);
    setSelectedClip((current) => {
      if (clip) return current?.id === clip.id ? current : clip;
      return current === null ? current : null;
    });
  }

  useEffect(() => { previewTimeRef.current = previewTime; }, [previewTime]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  function getOrLoadImage(url: string): HTMLImageElement | null {
    const cache = imageElsRef.current;
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.onload = () => {
        if (img && img.naturalWidth && img.naturalHeight) {
          const ratio = img.naturalWidth / img.naturalHeight;
          setCanvasSize((current) => {
            const currentRatio = current.width / current.height;
            if (Math.abs(currentRatio - ratio) < 0.02) return current;
            return ratio >= 1
              ? { width: 960, height: Math.round(960 / ratio) }
              : { width: Math.round(540 * ratio), height: 540 };
          });
        }
        drawFrameRef.current(previewTimeRef.current);
      };
      img.src = url;
      cache.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // Same style as the export engine's burned-in subtitles: bold white text
  // with a black outline, no background box. Sized for legibility in the
  // editor rather than an exact pixel-ratio match to the export resolution —
  // the export's fixed 22px is comfortably readable on a full 1080p playback
  // but would be nearly invisible at the small preview canvas size.
  function drawCaptionText(ctx: CanvasRenderingContext2D, width: number, height: number, text: string) {
    const fontSize = Math.max(18, Math.round(height * 0.045));
    ctx.font = `900 ${fontSize}px "Arial Black", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const maxWidth = width * 0.86;
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const lineHeight = fontSize * 1.25;
    const blockHeight = lines.length * lineHeight;
    const bottomMargin = height * 0.05;
    const startY = height - bottomMargin - blockHeight + lineHeight * 0.8;
    const outlineWidth = Math.max(2, fontSize * 0.16);
    ctx.lineJoin = "round";
    lines.forEach((textLine, index) => {
      const y = startY + index * lineHeight;
      ctx.lineWidth = outlineWidth;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(textLine, width / 2, y);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(textLine, width / 2, y);
    });
  }

  function getOrLoadVideo(url: string): HTMLVideoElement {
    const cache = videoElsRef.current;
    let video = cache.get(url);
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;
      cache.set(url, video);
    }
    return video;
  }

  function drawFrame(time: number) {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const clip = findClipAtTime(stillsClips, time);

    // Live playback of a generated animation clip draws real video frames;
    // while paused/scrubbing it falls through to the poster-frame path below
    // (renderId still points at the source still for every animation clip).
    let drewVideoFrame = false;
    const isAnimationClip = clip?.clipKind === "animation" && !!clip.videoAssetId;
    if (activeVideoElRef.current && (!isAnimationClip || activeAnimationAssetIdRef.current !== clip?.videoAssetId)) {
      activeVideoElRef.current.pause();
      activeVideoElRef.current = null;
      activeAnimationAssetIdRef.current = null;
    }
    if (isAnimationClip && isPlayingRef.current) {
      const videoUrl = videoAssetUrls[clip.videoAssetId as string];
      if (videoUrl) {
        const video = getOrLoadVideo(videoUrl);
        activeVideoElRef.current = video;
        activeAnimationAssetIdRef.current = clip.videoAssetId as string;
        const elapsedSeconds = Math.max(0, time - clip.startSeconds);
        if (Math.abs(video.currentTime - elapsedSeconds) > 0.15) {
          video.currentTime = elapsedSeconds;
        }
        if (video.paused) void video.play().catch(() => {});
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          const w = video.videoWidth * scale;
          const h = video.videoHeight * scale;
          ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
          drewVideoFrame = true;
          const clipDuration = clip.endSeconds - clip.startSeconds;
          const overlayAlpha = fadeOverlayAlpha(clip.transitionIn, clip.transitionOut, elapsedSeconds, clipDuration);
          if (overlayAlpha > 0) {
            ctx.globalAlpha = overlayAlpha;
            ctx.fillStyle = "#000000";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    if (!drewVideoFrame && clip?.renderId) {
      const url = renderUrls[clip.renderId];
      const img = url ? getOrLoadImage(url) : null;
      if (img) {
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        const base = {
          w: img.naturalWidth * scale,
          h: img.naturalHeight * scale,
          x: (canvas.width - img.naturalWidth * scale) / 2,
          y: (canvas.height - img.naturalHeight * scale) / 2,
        };
        // Clamp to 0 rather than going negative during the leading-gap
        // fallback (time before this clip's own start) — freezes on the
        // clip's first frame instead of extrapolating zoom/fade backwards.
        const elapsedSeconds = Math.max(0, time - clip.startSeconds);
        const clipDuration = clip.endSeconds - clip.startSeconds;
        const rect = applyMotion(clip.motionPreset, elapsedSeconds, clipDuration, clip.motionIntensity, base);
        ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h);
        // A fade-in/out at the two hard edges of the whole timeline has
        // nothing to fade from/to, so it just opens or closes on black —
        // ignore the setting there even if "Fade all" applied it globally.
        const isFirstClip = clip === stillsClips[0];
        // Only the true tail-end (nothing after it, no trailing gap) counts —
        // a fade-out into an actual black gap further down the timeline is
        // still a legitimate, visible transition.
        const isTrueLastClip = clip === stillsClips[stillsClips.length - 1] && clip.endSeconds >= totalDuration - 0.05;
        const effectiveTransitionIn = isFirstClip ? "cut" : clip.transitionIn;
        const effectiveTransitionOut = isTrueLastClip ? "cut" : clip.transitionOut;
        const overlayAlpha = fadeOverlayAlpha(effectiveTransitionIn, effectiveTransitionOut, elapsedSeconds, clipDuration);
        if (overlayAlpha > 0) {
          ctx.globalAlpha = overlayAlpha;
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }
      }
    }
    const caption = captionClips.find((c) => time >= c.startSeconds && time < c.endSeconds);
    if (caption) drawCaptionText(ctx, canvas.width, canvas.height, caption.text);
  }
  drawFrameRef.current = drawFrame;

  useEffect(() => {
    drawFrameRef.current(previewTimeRef.current);
  }, [stillsClips, captionClips, renderUrls, videoAssetUrls, canvasSize]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  function stepFrame() {
    const audio = audioRef.current;
    let t = previewTimeRef.current;
    if (audio && audioDataUrl) {
      t = audio.currentTime;
      if (audio.ended) {
        pausePreview();
        return;
      }
    } else if (playStartRef.current) {
      t = playStartRef.current.timeStart + (performance.now() - playStartRef.current.wallStart) / 1000;
    }
    if (t >= totalDuration) {
      previewTimeRef.current = totalDuration;
      setPreviewTime(totalDuration);
      drawFrameRef.current(totalDuration);
      pausePreview();
      return;
    }
    previewTimeRef.current = t;
    setPreviewTime(t);
    drawFrameRef.current(t);
    updateSelectionForTime(t);
    scrollTimelineToTime(t);
    if (isPlayingRef.current) rafRef.current = requestAnimationFrame(stepFrame);
  }

  function playPreview() {
    if (isPlayingRef.current || !stillsClips.length) return;
    let startAt = previewTimeRef.current;
    if (startAt >= totalDuration) startAt = 0;
    isPlayingRef.current = true;
    setIsPlaying(true);
    previewTimeRef.current = startAt;
    setPreviewTime(startAt);
    if (audioRef.current && audioDataUrl) {
      audioRef.current.currentTime = startAt;
      void audioRef.current.play();
    } else {
      playStartRef.current = { wallStart: performance.now(), timeStart: startAt };
    }
    rafRef.current = requestAnimationFrame(stepFrame);
  }

  function pausePreview() {
    isPlayingRef.current = false;
    setIsPlaying(false);
    audioRef.current?.pause();
    activeVideoElRef.current?.pause();
    playStartRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }

  function seekPreview(time: number) {
    const clamped = Math.max(0, Math.min(totalDuration, time));
    previewTimeRef.current = clamped;
    setPreviewTime(clamped);
    if (audioRef.current && audioDataUrl) audioRef.current.currentTime = clamped;
    if (isPlayingRef.current && (!audioRef.current || !audioDataUrl)) {
      playStartRef.current = { wallStart: performance.now(), timeStart: clamped };
    }
    drawFrameRef.current(clamped);
    updateSelectionForTime(clamped);
    scrollTimelineToTime(clamped);
  }

  async function refresh(promise: Promise<TimelineRecord>) {
    try {
      const next = await promise;
      if (activeVideoId) setCachedData(`tl-timeline:${activeVideoId}`, next);
      setTimeline(next);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function updateZoom(nextZoom: number) {
    if (!activeVideoId || !timeline) return;
    await refresh(projectsClient.updateTimelineView(activeVideoId, timeline.playheadSeconds, nextZoom));
  }

  function beginPlayheadDrag(event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (isPlayingRef.current) pausePreview();
    playheadDragRef.current = true;
  }

  function onDragPointerMove(event: ReactPointerEvent) {
    if (!playheadDragRef.current) return;
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    if (rect) seekPreview(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
  }

  function endDrag() {
    playheadDragRef.current = false;
  }

  function scrollTimelineToTime(time: number) {
    const container = canvasScrollRef.current;
    if (!container) return;
    const targetPx = secondsToPixels(time, pixelsPerSecond);
    const viewStart = container.scrollLeft;
    const viewEnd = viewStart + container.clientWidth;
    if (targetPx < viewStart || targetPx > viewEnd) {
      container.scrollTo({ left: Math.max(0, targetPx - container.clientWidth / 2), behavior: "smooth" });
    }
  }

  async function selectStillInSource(groupId: string) {
    const clip = stillsClips.find((candidate) => candidate.groupId === groupId);
    if (clip) {
      seekPreview(clip.startSeconds);
      scrollTimelineToTime(clip.startSeconds);
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
      scrollTimelineToTime(addedClip.startSeconds);
    }
  }

  async function resetEffects() {
    if (!activeVideoId || !selectedClip) return;
    const clipId = selectedClip.id;
    await refresh(projectsClient.setTimelineClipMotion(activeVideoId, clipId, "none"));
    await refresh(projectsClient.setTimelineClipTransition(activeVideoId, clipId, "cut"));
    await refresh(projectsClient.setTimelineClipTransitionOut(activeVideoId, clipId, "cut"));
  }

  async function swapRender(renderId: string) {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.setTimelineClipRender(activeVideoId, selectedClip.id, renderId));
  }

  async function setMotion(preset: MotionPreset) {
    if (!activeVideoId || !selectedClip) return;
    // Clicking the already-active preset unselects it (back to no motion).
    const next = selectedClip.motionPreset === preset ? "none" : preset;
    await refresh(projectsClient.setTimelineClipMotion(activeVideoId, selectedClip.id, next));
  }

  async function toggleTransitionIn() {
    if (!activeVideoId || !selectedClip) return;
    const next = selectedClip.transitionIn === "fade" ? "cut" : "fade";
    await refresh(projectsClient.setTimelineClipTransition(activeVideoId, selectedClip.id, next));
  }

  async function toggleTransitionOut() {
    if (!activeVideoId || !selectedClip) return;
    const next = selectedClip.transitionOut === "fade" ? "cut" : "fade";
    await refresh(projectsClient.setTimelineClipTransitionOut(activeVideoId, selectedClip.id, next));
  }

  async function applyMotionToAll() {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.applyMotionToAllClips(activeVideoId, selectedClip.motionPreset, globalIntensity));
    addToast("Camera movement applied to all stills.", "success");
  }

  async function applyTransitionInToAll() {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.applyTransitionInToAllClips(activeVideoId, selectedClip.transitionIn));
    addToast("Transition in applied to all stills.", "success");
  }

  async function applyTransitionOutToAll() {
    if (!activeVideoId || !selectedClip) return;
    await refresh(projectsClient.applyTransitionOutToAllClips(activeVideoId, selectedClip.transitionOut));
    addToast("Transition out applied to all stills.", "success");
  }

  async function applyGlobalIntensity(intensity: number) {
    setGlobalIntensity(intensity);
    if (!activeVideoId) return;
    await refresh(projectsClient.applyMotionIntensityToAllClips(activeVideoId, intensity));
  }

  async function alternateZoom() {
    if (!activeVideoId) return;
    await refresh(projectsClient.alternateZoomForAllClips(activeVideoId, globalIntensity));
    addToast("Alternating zoom in/out applied across all stills.", "success");
  }

  async function applyFadeTransitionToAll() {
    if (!activeVideoId) return;
    await refresh(projectsClient.applyTransitionInToAllClips(activeVideoId, "fade"));
    await refresh(projectsClient.applyTransitionOutToAllClips(activeVideoId, "fade"));
    addToast("Fade transition applied to every still.", "success");
  }

  async function removeTransitionFromAll() {
    if (!activeVideoId) return;
    await refresh(projectsClient.applyTransitionInToAllClips(activeVideoId, "cut"));
    await refresh(projectsClient.applyTransitionOutToAllClips(activeVideoId, "cut"));
    addToast("Transition removed from every still.", "success");
  }

  async function removeAllEffects() {
    if (!activeVideoId) return;
    await refresh(projectsClient.applyMotionToAllClips(activeVideoId, "none", globalIntensity));
    await refresh(projectsClient.applyTransitionInToAllClips(activeVideoId, "cut"));
    await refresh(projectsClient.applyTransitionOutToAllClips(activeVideoId, "cut"));
    await refresh(projectsClient.resetStillsTimingToNatural(activeVideoId));
    addToast("Removed camera movement, transitions, and any gap-filling stretch from every still.", "success");
  }

  async function extrapolateStills() {
    if (!activeVideoId) return;
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
    await refresh(projectsClient.extrapolateStillsToFillGaps(activeVideoId, duration));
    addToast("Stills stretched to close every gap.", "success");
  }

  async function generateAnimation() {
    if (!activeVideoId || !selectedClip || selectedClip.clipKind !== "still") return;
    try {
      setError(null);
      setAnimationJob(await projectsClient.createAnimationJob(activeVideoId, selectedClip.id, animationResolution, animationPrompt));
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function suggestAnimationPrompt() {
    if (!activeVideoId || !selectedClip || selectedClip.clipKind !== "still") return;
    setSuggestingPrompt(true);
    setError(null);
    try {
      setAnimationPrompt(await projectsClient.suggestAnimationPrompt(activeVideoId, selectedClip.groupId));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSuggestingPrompt(false);
    }
  }

  async function cancelAnimationGeneration() {
    if (!animationJob) return;
    await projectsClient.controlAnimationJob(animationJob.id, "stop");
  }

  useEffect(() => {
    if (!animationJob || !activeVideoId || !["queued", "running"].includes(animationJob.status)) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const latest = await projectsClient.getLatestAnimationJob(activeVideoId);
        if (cancelled || !latest) return;
        setAnimationJob(latest);
        if (latest.status === "completed") {
          addToast("Animation generated.", "success");
          await refresh(projectsClient.getTimeline(activeVideoId));
        } else if (latest.status === "failed") {
          const failedItem = latest.items.find((item) => item.status === "failed");
          setError(failedItem?.lastError ?? "Animation generation failed.");
        }
      } catch {
        // Transient — keep polling until it settles.
      }
    }, 1500);
    return () => { cancelled = true; window.clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animationJob?.id, animationJob?.status, activeVideoId]);

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
    const defaultName = `${(activeVideoTitle || "video").replace(/[\\/:*?"<>|]+/g, " ").trim() || "video"}.mp4`;
    const destinationPath = await projectsClient.pickExportDestination(defaultName);
    if (!destinationPath) return;
    pausePreview();
    setExporting(true);
    setExportProgress({ percent: 0, stage: "Preparing export", detail: "" });
    setError(null);
    try {
      const savedPath = await projectsClient.exportTimelineVideo(activeVideoId, destinationPath);
      if (savedPath) addToast(`Video exported to ${savedPath}`, "success");
      setExportModal(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setExporting(false);
    }
  }

  async function startExportProject() {
    if (!activeVideoId) return;
    const destinationPath = await projectsClient.pickExportProjectDestination();
    if (!destinationPath) return;
    pausePreview();
    setExporting(true);
    setExportProgress({ percent: 0, stage: "Preparing export", detail: "" });
    setError(null);
    try {
      const savedPath = await projectsClient.exportTimelineProject(activeVideoId, destinationPath);
      addToast(`Project assets exported to ${savedPath}`, "success");
      setExportModal(null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setExporting(false);
    }
  }

  async function cancelExport() {
    if (!activeVideoId) return;
    await projectsClient.cancelTimelineExport(activeVideoId);
  }

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
          <p className="eyebrow">Editor</p>
          <h1>Timeline</h1>
          <p>Arrange your stills and preview the finished video — captions and narration stay perfectly synced automatically.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary" onClick={() => setExportModal("project")} disabled={!timeline.clips.length}><Sparkles size={16} />Export project</button>
          <button className="primary" onClick={() => setExportModal("video")} disabled={!timeline.clips.length}><Download size={16} />Export video</button>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <>
        <div className="tl-workspace">
          <aside className="tl-media-pane">
            <div className="tl-source-tabs">
              <button className={sourceTab === "stills" ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setSourceTab("stills")}>Stills</button>
              <button className={sourceTab === "animations" ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setSourceTab("animations")}>Animations</button>
            </div>
            {sourceTab === "stills" && (
              <div className="tl-source-section">
                <strong>Stills<span>{workspace?.groups.length ?? 0}</span></strong>
                <div className="tl-source-grid">
                  {workspace?.groups.map((group) => (
                    <button
                      key={group.group.id}
                      className="tl-source-thumb-btn"
                      title={`Jump to still ${group.group.ordinal}`}
                      onClick={() => void selectStillInSource(group.group.id)}
                    >
                      <span className="tl-source-badge">{group.group.ordinal}</span>
                      {renderUrls[group.imageRenders[0]?.id] ? <img src={renderUrls[group.imageRenders[0]?.id]} alt="" /> : <ImageOff size={16} />}
                    </button>
                  ))}
                  {!workspace?.groups.length && <div className="tl-source-empty">No stills yet.</div>}
                </div>
              </div>
            )}
            {sourceTab === "animations" && (
              <div className="tl-source-section tl-broll-panel">
                <strong><Clapperboard size={14} />Animations</strong>
                {selectedClip && selectedClip.clipKind === "still" ? (
                  <>
                    <div className="tl-source-thumb-preview">
                      {selectedClip.renderId && renderUrls[selectedClip.renderId]
                        ? <img src={renderUrls[selectedClip.renderId]} alt="" />
                        : <ImageOff size={16} />}
                    </div>
                    <div className="tl-inspector-group">
                      <span className="tl-inspector-label">Resolution</span>
                      <div className="tl-preset-grid two">
                        {(["720p", "1080p"] as VeoResolution[]).map((option) => (
                          <button
                            key={option}
                            className={animationResolution === option ? "tl-preset-btn active" : "tl-preset-btn"}
                            onClick={() => setAnimationResolution(option)}
                          >
                            <span>{option}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="tl-inspector-group">
                      <div className="tl-inspector-label-row">
                        <span className="tl-inspector-label">Animation prompt</span>
                        <button className="tl-apply-all-btn" disabled={suggestingPrompt} onClick={() => void suggestAnimationPrompt()}>
                          {suggestingPrompt ? "Suggesting…" : "Suggest prompt"}
                        </button>
                      </div>
                      <textarea
                        className="tl-prompt-textarea"
                        placeholder="Describe the motion to add (camera drift, wind, gestures…) — leave blank to let Veo decide, or click Suggest prompt for an AI variation based on this still's narration."
                        value={animationPrompt}
                        onChange={(event) => setAnimationPrompt(event.target.value)}
                        rows={4}
                      />
                      <p className="tl-source-hint">
                        This exact text is sent to Veo alongside the still. Edit it freely, or click "Suggest prompt"
                        again for a different variation grounded in this still's narration.
                      </p>
                    </div>
                    <p className="tl-source-hint">
                      Veo only generates 4s, 6s, or 8s clips — this will generate as{" "}
                      {pickVeoDuration(selectedClip.endSeconds - selectedClip.startSeconds)}s. Use "Adjust animation to
                      duration" afterward to stretch it to exactly fill this {formatTime(selectedClip.endSeconds - selectedClip.startSeconds)} slot.
                    </p>
                    <button className="primary full" onClick={() => void generateAnimation()}>
                      <Clapperboard size={14} />Generate Animation
                    </button>
                  </>
                ) : (
                  <p className="tl-source-hint">Select a still on the timeline to animate it.</p>
                )}
              </div>
            )}
          </aside>
          <div className="tl-preview-pane">
            <div className="tl-preview-frame">
              {stillsClips.length ? (
                <canvas ref={previewCanvasRef} width={canvasSize.width} height={canvasSize.height} />
              ) : (
                <div className="tl-preview-empty">Add stills to preview your video.</div>
              )}
            </div>
          </div>
          <aside className="tl-inspector-pane">
            <div className="tl-source-tabs">
              <button className={inspectorTab === "clip" ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setInspectorTab("clip")}>Clip</button>
              <button className={inspectorTab === "global" ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setInspectorTab("global")}>Global</button>
            </div>
            {inspectorTab === "global" && (
              <div className="tl-source-section">
                <strong><SlidersHorizontal size={14} />Global settings</strong>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Camera movement intensity</span>
                  <div className="tl-intensity-control">
                    <input
                      type="range"
                      className="tl-slider"
                      min={0.05}
                      max={0.5}
                      step={0.01}
                      value={globalIntensity}
                      onChange={(event) => void applyGlobalIntensity(Number(event.target.value))}
                    />
                    <span className="tl-intensity-value">{Math.round(globalIntensity * 100)}%</span>
                  </div>
                  <p className="tl-source-hint">Applies to every still's zoom strength immediately.</p>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Alternate zoom</span>
                  <button className="secondary" onClick={() => void alternateZoom()}><Shuffle size={14} />Alternate zoom in/out</button>
                  <p className="tl-source-hint">Assigns alternating zoom-in and zoom-out across every still, in order.</p>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Transitions</span>
                  <div className="tl-preset-grid two">
                    <button className="secondary" onClick={() => void applyFadeTransitionToAll()}><Sparkles size={14} />Fade all</button>
                    <button className="secondary" onClick={() => void removeTransitionFromAll()}><Scissors size={14} />Cut all</button>
                  </div>
                  <p className="tl-source-hint">Sets the fade-in/fade-out transition on every still at once.</p>
                </div>
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label">Gaps</span>
                  <button className="secondary" onClick={() => void extrapolateStills()}><Move size={14} />Extrapolate stills to fill gaps</button>
                  <p className="tl-source-hint">
                    Stretches every still to close gaps between them (from silence between sentences), so they tile
                    back-to-back — this is what makes transitions actually visible.
                  </p>
                </div>
                <div className="tl-inspector-group">
                  <button className="secondary danger-action" onClick={() => void removeAllEffects()}><Trash2 size={14} />Remove all effects</button>
                </div>
              </div>
            )}
            {inspectorTab === "clip" && (selectedClip ? (
              <div className="tl-inspector">
                <div className="tl-inspector-header">
                  <strong>Still</strong>
                  <span>{formatTime(selectedClip.startSeconds)} – {formatTime(selectedClip.endSeconds)}</span>
                </div>
                {selectedClipRenders.length > 1 && (
                  <div className="tl-inspector-group">
                    <span className="tl-inspector-label">Version</span>
                    <div className="tl-version-chips">
                      {selectedClipRenders.map((render) => (
                        <button
                          key={render.id}
                          className={render.id === selectedClip.renderId ? "tl-version-chip active" : "tl-version-chip"}
                          onClick={() => void swapRender(render.id)}
                        >
                          V{render.version}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {selectedClip.clipKind === "animation" && (
                  <div className="tl-inspector-group">
                    <span className="tl-inspector-label">Prompt sent to Veo</span>
                    <p className="tl-source-hint tl-prompt-readout">
                      {selectedClipVideoAsset?.prompt ? selectedClipVideoAsset.prompt : "(no prompt — Veo decided the motion on its own)"}
                    </p>
                  </div>
                )}
                {selectedClip.clipKind === "animation" && (
                  <div className="tl-inspector-group">
                    <span className="tl-inspector-label"><Clock size={12} />Animation duration</span>
                    {selectedClipVideoAsset && Math.abs(selectedClipVideoAsset.actualDurationSeconds - (selectedClip.endSeconds - selectedClip.startSeconds)) > 0.05 ? (
                      <>
                        <p className="tl-source-hint">
                          Doesn't match its slot ({selectedClipVideoAsset.actualDurationSeconds.toFixed(1)}s vs{" "}
                          {(selectedClip.endSeconds - selectedClip.startSeconds).toFixed(1)}s).
                        </p>
                        <button className="secondary" disabled={retiming} onClick={() => void adjustAnimationToDuration()}>
                          <Clock size={14} />{retiming ? "Adjusting…" : "Adjust animation to duration"}
                        </button>
                      </>
                    ) : (
                      <p className="tl-source-hint">Matches its timeline slot.</p>
                    )}
                  </div>
                )}
                {selectedClip.clipKind === "animation" && (
                  <div className="tl-inspector-group">
                    <button className="secondary" onClick={() => void undoAnimation()}>
                      <Undo2 size={14} />Undo animation
                    </button>
                    <p className="tl-source-hint">
                      Reverts to the still. The generated animation stays cached — restore it any time from the
                      Animations tab, unless you generate a new one first.
                    </p>
                  </div>
                )}
                {selectedClip.clipKind === "still" && selectedClip.videoAssetId && (
                  <div className="tl-inspector-group">
                    <button className="secondary" onClick={() => void restoreAnimation()}>
                      <Redo2 size={14} />Restore cached animation
                    </button>
                    <p className="tl-source-hint">A previously generated animation for this still is cached and ready to bring back.</p>
                  </div>
                )}
                {selectedClip.clipKind !== "animation" && (
                  <div className="tl-inspector-group">
                    <div className="tl-inspector-label-row">
                      <span className="tl-inspector-label"><Move size={12} />Camera movement</span>
                      <button className="tl-apply-all-btn" onClick={() => void applyMotionToAll()}>Apply to all</button>
                    </div>
                    <div className="tl-preset-grid two">
                      {MOTION_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          className={selectedClip.motionPreset === option.value ? "tl-preset-btn active" : "tl-preset-btn"}
                          onClick={() => void setMotion(option.value)}
                          title={option.label}
                        >
                          <option.icon size={13} />
                          <span>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="tl-inspector-group">
                  <div className="tl-inspector-label-row">
                    <span className="tl-inspector-label"><Sparkles size={12} />Transition in</span>
                    <button className="tl-apply-all-btn" onClick={() => void applyTransitionInToAll()}>Apply to all</button>
                  </div>
                  <button
                    className={selectedClip.transitionIn === "fade" ? "tl-preset-btn active full" : "tl-preset-btn full"}
                    onClick={() => void toggleTransitionIn()}
                    title="Fade in from black"
                  >
                    <Sparkles size={13} /><span>Fade</span>
                  </button>
                </div>
                <div className="tl-inspector-group">
                  <div className="tl-inspector-label-row">
                    <span className="tl-inspector-label"><Sparkles size={12} />Transition out</span>
                    <button className="tl-apply-all-btn" onClick={() => void applyTransitionOutToAll()}>Apply to all</button>
                  </div>
                  <button
                    className={selectedClip.transitionOut === "fade" ? "tl-preset-btn active full" : "tl-preset-btn full"}
                    onClick={() => void toggleTransitionOut()}
                    title="Fade out to black"
                  >
                    <Sparkles size={13} /><span>Fade</span>
                  </button>
                </div>
                <div className="tl-inspector-actions">
                  <button className="secondary" onClick={() => void resetEffects()}><Trash2 size={14} />Remove effects</button>
                </div>
              </div>
            ) : (
              <div className="tl-inspector-empty">
                <Move size={22} />
                <p>Select a still on the timeline to edit its camera movement, transition, and version.</p>
              </div>
            ))}
          </aside>
        </div>
        <div className="tl-timeline-pane">
          <div className="tl-toolbar">
            <span className="tl-preview-time">{formatTime(previewTime)} <i>/</i> {formatTime(totalDuration)}</span>
            <button
              className="tl-play-btn"
              onClick={() => (isPlaying ? pausePreview() : playPreview())}
              disabled={!stillsClips.length}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <div className="tl-zoom-control">
              <button className="tl-icon-btn" title="Zoom out" onClick={() => void updateZoom(Math.max(ZOOM_MIN, zoom - 0.25))}><Minus size={13} /></button>
              <input type="range" className="tl-slider" min={ZOOM_MIN} max={ZOOM_MAX} step=".25" value={zoom} onChange={(event) => void updateZoom(Number(event.target.value))} />
              <button className="tl-icon-btn" title="Zoom in" onClick={() => void updateZoom(Math.min(ZOOM_MAX, zoom + 0.25))}><Plus size={13} /></button>
              <span className="tl-zoom-label">{Math.round(zoom * 100)}%</span>
            </div>
          </div>
          <div className="tl-canvas">
            <div className="tl-lane-gutter">
              <div className="tl-gutter-cell" style={{ height: NARRATION_LANE_HEIGHT }}>Narration</div>
              <div className="tl-gutter-cell" style={{ height: STILLS_LANE_HEIGHT }}>Stills</div>
              <div className="tl-gutter-cell" style={{ height: CAPTIONS_LANE_HEIGHT }}>Captions</div>
            </div>
            <div ref={canvasScrollRef} className="tl-canvas-scroll" onPointerMove={onDragPointerMove} onPointerUp={endDrag}>
              <div
                ref={canvasInnerRef}
                className="tl-canvas-inner"
                style={{ width: totalWidthPx }}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  seekPreview(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
                }}
              >
                <div className="tl-playhead" style={{ left: playheadPx }}>
                  <div className="tl-playhead-handle" onPointerDown={beginPlayheadDrag} />
                  <span className="tl-playhead-tag" onPointerDown={beginPlayheadDrag}>{formatTime(previewTime)}</span>
                </div>
                <div className="tl-lane-track tl-narration-track" style={{ height: NARRATION_LANE_HEIGHT }}>
                  <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={setNarrationDuration} />
                </div>
                <div className="tl-lane-track" style={{ height: STILLS_LANE_HEIGHT }}>
                  {stillsClips.map((clip) => (
                    <div
                      key={clip.id}
                      className={selectedClip?.id === clip.id ? "tl-clip tl-clip-stills active" : "tl-clip tl-clip-stills"}
                      style={{ left: secondsToPixels(clip.startSeconds, pixelsPerSecond), width: Math.max(4, secondsToPixels(clip.endSeconds - clip.startSeconds, pixelsPerSecond)) }}
                      onClick={(event) => { event.stopPropagation(); seekPreview(clip.startSeconds); }}
                    >
                      {clip.renderId && renderUrls[clip.renderId] ? <img src={renderUrls[clip.renderId]} alt="" draggable={false} /> : <span className="tl-clip-fallback">{clip.label}</span>}
                      {clip.transitionIn === "fade" && <span className="tl-clip-badge tl-clip-badge-fade" title="Fade in"><Sparkles size={10} /></span>}
                      {clip.motionPreset !== "none" && <span className="tl-clip-badge tl-clip-badge-motion" title={`Camera: ${motionLabel(clip.motionPreset)}`}><Move size={10} /></span>}
                      {clip.clipKind === "animation" && <span className="tl-clip-badge tl-clip-badge-animation" title="Animated with Veo"><Clapperboard size={10} /></span>}
                    </div>
                  ))}
                </div>
                <div className="tl-lane-track tl-captions-track" style={{ height: CAPTIONS_LANE_HEIGHT }}>
                  {captionClips.map((chunk) => {
                    const chunkWidth = Math.max(3, secondsToPixels(chunk.endSeconds - chunk.startSeconds, pixelsPerSecond));
                    return (
                      <div
                        key={chunk.index}
                        className={chunkWidth >= 46 ? "tl-clip tl-clip-captions readonly" : "tl-clip tl-clip-captions readonly narrow"}
                        style={{ left: secondsToPixels(chunk.startSeconds, pixelsPerSecond), width: chunkWidth }}
                        title={chunk.text}
                      >
                        {chunkWidth >= 46 && <span className="tl-clip-text">{chunk.text}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
      {exportModal && !exporting && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setExportModal(null)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Export</p>
            <h2>{exportModal === "project" ? "Export project" : "Export video"}</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              {exportModal === "project"
                ? "Exports everything on the timeline as separate, editor-ready assets instead of one baked video: every still becomes its own clip file, stretched to close any silence gap and trimmed to its exact duration, plus the narration audio and captions as their own files — ready to drop onto separate tracks in CapCut or any other editor, preserving your timeline's exact durations. You'll be asked to choose a destination folder before it starts."
                : "Renders exactly what's currently on the timeline — stills, burned-in captions, and the narration audio — into a single MP4. You'll be asked where to save it before rendering starts. This can take several minutes for a long video."}
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setExportModal(null)}>Cancel</button>
              <button className="primary" onClick={() => void (exportModal === "project" ? startExportProject() : startExport())}>
                <Play size={15} />Start export
              </button>
            </div>
          </section>
        </div>
      )}
      {exporting && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card generation-progress">
            <div className="progress-heading">
              <LoaderCircle className="spin" size={26} />
              <strong>{exportProgress.stage}</strong>
              <b>{Math.max(0, Math.min(100, exportProgress.percent))}%</b>
            </div>
            <span>{exportProgress.detail || "Starting the export engine…"}</span>
            <div className="loading-bar determinate"><i style={{ width: `${exportProgress.percent}%` }} /></div>
            <button className="secondary" style={{ marginTop: "14px" }} onClick={() => void cancelExport()}><Square size={13} />Stop</button>
          </div>
        </div>
      )}
      {animationJob && (animationJob.status === "queued" || animationJob.status === "running") && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="loading-card generation-progress">
            <div className="progress-heading">
              <LoaderCircle className="spin" size={26} />
              <strong>Generating animation</strong>
            </div>
            <span>Veo is animating your still at {animationResolution} — this can take a few minutes.</span>
            <button className="secondary" style={{ marginTop: "14px" }} onClick={() => void cancelAnimationGeneration()}><Square size={13} />Stop</button>
          </div>
        </div>
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

function NarrationWaveform({
  audioDataUrl,
  pixelsPerSecond,
  canvasRef,
  onDuration,
}: {
  audioDataUrl: string | null;
  pixelsPerSecond: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onDuration: (seconds: number) => void;
}) {
  useEffect(() => {
    if (!audioDataUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(audioDataUrl);
        const arrayBuffer = await response.arrayBuffer();
        const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const audioContext = new AudioContextCtor();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        if (cancelled) return;
        onDuration(audioBuffer.duration);
        const channel = audioBuffer.getChannelData(0);
        const width = Math.max(1, Math.round(audioBuffer.duration * pixelsPerSecond));
        const height = NARRATION_LANE_HEIGHT;
        const canvas = canvasRef.current;
        if (canvas) {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.clearRect(0, 0, width, height);
            const brandColor = getComputedStyle(document.documentElement).getPropertyValue("--brand").trim();
            ctx.fillStyle = brandColor || "#58c994";
            const samplesPerPixel = Math.max(1, Math.floor(channel.length / width));
            for (let x = 0; x < width; x++) {
              let min = 1;
              let max = -1;
              const base = x * samplesPerPixel;
              for (let i = 0; i < samplesPerPixel; i++) {
                const sample = channel[base + i] ?? 0;
                if (sample < min) min = sample;
                if (sample > max) max = sample;
              }
              const y1 = (1 + min) * 0.5 * height;
              const y2 = (1 + max) * 0.5 * height;
              ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
            }
          }
        }
        void audioContext.close();
      } catch {
        // Waveform is a visual aid only — silently skip if decoding fails.
      }
    })();
    return () => { cancelled = true; };
  }, [audioDataUrl, pixelsPerSecond, canvasRef, onDuration]);

  if (!audioDataUrl) {
    return <div className="tl-narration-empty">No narration audio uploaded yet.</div>;
  }
  return <canvas ref={canvasRef} className="tl-waveform-canvas" />;
}

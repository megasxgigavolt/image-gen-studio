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
  Type,
  Undo2,
  Upload,
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
  type CaptionStyle,
  type ImageRenderRecord,
  type ImageWorkspaceRecord,
  type MotionPreset,
  type TimelineCaptionClipRecord,
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

// Mirrors the Rust default_caption_style() exactly, so an all-default style
// looks identical to what used to be hardcoded in the export engine.
const DEFAULT_CAPTION_STYLE: Required<CaptionStyle> = {
  fontFamily: "Arial Black",
  fontSizePx: 22,
  bold: true,
  color: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidthPx: 2,
  shadow: { enabled: false, blur: 4, offsetX: 0, offsetY: 2 },
  position: "bottom",
  wordHighlight: { enabled: false, color: "#FFEB3B" },
};

const CAPTION_FONT_OPTIONS = ["Arial Black", "Arial", "Impact", "Verdana", "Georgia", "Courier New"];

const CAPTION_STYLE_PRESETS: { label: string; style: Partial<CaptionStyle> }[] = [
  { label: "Clean White", style: { color: "#FFFFFF", outlineColor: "#000000", bold: true, shadow: { enabled: false, blur: 4, offsetX: 0, offsetY: 2 } } },
  { label: "Bold Yellow", style: { color: "#FFEB3B", outlineColor: "#000000", outlineWidthPx: 3, bold: true, shadow: { enabled: false, blur: 4, offsetX: 0, offsetY: 2 } } },
  { label: "Impact Red", style: { color: "#FFFFFF", outlineColor: "#D32F2F", outlineWidthPx: 3, bold: true, shadow: { enabled: false, blur: 4, offsetX: 0, offsetY: 2 } } },
  { label: "Soft Shadow", style: { color: "#FFFFFF", outlineColor: "#000000", outlineWidthPx: 1, bold: false, shadow: { enabled: true, blur: 6, offsetX: 0, offsetY: 3 } } },
];

/** Shallow-merges a partial style onto a base — mirrors the Rust merge_style. */
function resolveCaptionStyle(base: CaptionStyle, overlay?: CaptionStyle | null): Required<CaptionStyle> {
  return { ...DEFAULT_CAPTION_STYLE, ...base, ...(overlay ?? {}) };
}

const MOTION_OPTIONS: { value: MotionPreset; label: string; icon: typeof Move }[] = [
  { value: "zoom-in", label: "Zoom in", icon: ZoomIn },
  { value: "zoom-out", label: "Zoom out", icon: ZoomOut },
  { value: "zoom-pulse", label: "Zoom pulse", icon: Shuffle },
  { value: "zoom-in-subject", label: "Zoom in on subject", icon: ZoomIn },
  { value: "zoom-out-subject", label: "Zoom out on subject", icon: ZoomOut },
];

function motionLabel(preset: MotionPreset): string {
  return MOTION_OPTIONS.find((option) => option.value === preset)?.label ?? "None";
}

// Matches the export engine: `intensity` is the total zoom/pan amount over
// REFERENCE_DURATION seconds, applied as a constant per-second rate to every
// clip so the effect feels equally fast regardless of a still's own duration.
// `MAX_SCALE_REFERENCE_DURATION` only bounds pathological cases (it's well
// beyond any realistic still duration) — it must never be reached in normal
// use, unlike the old `1 + amount*3` cap which froze zoom at exactly 15s.
const MOTION_REFERENCE_DURATION = 5.0;
const MAX_SCALE_REFERENCE_DURATION = 60.0;

function applyMotion(
  motion: MotionPreset,
  elapsedSeconds: number,
  duration: number,
  intensity: number,
  rect: { x: number; y: number; w: number; h: number },
  subject?: { x: number; y: number },
) {
  if (motion === "none") return rect;
  const amount = Math.max(0.02, Math.min(0.6, intensity));
  const rate = amount / MOTION_REFERENCE_DURATION;
  const maxScale = 1 + amount * (MAX_SCALE_REFERENCE_DURATION / MOTION_REFERENCE_DURATION);
  const peak = 1 + amount;
  let scaleMul = 1;
  let panX = subject?.x ?? 0.5;
  let panY = subject?.y ?? 0.5;
  if (motion === "zoom-in" || motion === "zoom-in-subject") {
    scaleMul = Math.min(maxScale, 1 + rate * elapsedSeconds);
  } else if (motion === "zoom-out" || motion === "zoom-out-subject") {
    scaleMul = Math.min(maxScale, 1 + rate * (duration - elapsedSeconds));
  } else if (motion === "zoom-pulse") {
    const half = duration / 2;
    scaleMul = elapsedSeconds < half
      ? Math.min(maxScale, 1 + rate * elapsedSeconds)
      : Math.max(1, Math.min(maxScale, 1 + rate * half) - rate * (elapsedSeconds - half));
    panX = 0.5;
    panY = 0.5;
  } else if (motion === "pan-left") {
    scaleMul = peak;
    panX = 1 - Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
    panY = 0.5;
  } else if (motion === "pan-right") {
    scaleMul = peak;
    panX = Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
    panY = 0.5;
  }
  const w = rect.w * scaleMul;
  const h = rect.h * scaleMul;
  return { x: rect.x - (w - rect.w) * panX, y: rect.y - (h - rect.h) * panY, w, h };
}

// Matches the export engine's fade window: proportional to the clip's own
// duration (~8%), floored so short clips still get a perceptible fade, and
// capped at half the duration so in+out fades on a short clip never overlap.
function fadeOverlayAlpha(
  transitionIn: string,
  transitionOut: string,
  elapsedSeconds: number,
  duration: number,
): number {
  const fadeDuration = Math.max(0.15, Math.min(duration / 2, duration * 0.08));
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
  const [subjectByRender, setSubjectByRender] = useState<Record<string, { x: number; y: number }>>({});
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
  const [inspectorTab, setInspectorTab] = useState<"clip" | "global" | "captions">("clip");
  const [globalIntensity, setGlobalIntensity] = useState(0.22);
  const [videoAssetUrls, setVideoAssetUrls] = useState<Record<string, string>>({});
  const [animationResolution, setAnimationResolution] = useState<VeoResolution>("720p");
  const [animationPrompt, setAnimationPrompt] = useState("");
  const [animateMode, setAnimateMode] = useState<"choose" | "generate">("choose");
  const [suggestingPrompt, setSuggestingPrompt] = useState(false);
  const [animationJob, setAnimationJob] = useState<AnimationJobRecord | null>(null);
  const [selectedClipVideoAsset, setSelectedClipVideoAsset] = useState<VideoAssetRecord | null>(null);
  const [retiming, setRetiming] = useState(false);
  const [extrapolating, setExtrapolating] = useState(false);
  const [uploadingAnimation, setUploadingAnimation] = useState(false);
  const [selectedCaptionClip, setSelectedCaptionClip] = useState<TimelineCaptionClipRecord | null>(null);
  const [captionText, setCaptionText] = useState("");
  const [captionInterval, setCaptionInterval] = useState(1);
  const [generatingCaptions, setGeneratingCaptions] = useState(false);
  const [captionProgress, setCaptionProgress] = useState({ percent: 0, stage: "Preparing captions", detail: "" });
  const [confirmRegenerateCaptions, setConfirmRegenerateCaptions] = useState(false);
  const [confirmResetTimeline, setConfirmResetTimeline] = useState(false);
  const [resettingTimeline, setResettingTimeline] = useState(false);
  const [captionDragPreview, setCaptionDragPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [stillsDragPreview, setStillsDragPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [narrationDragPreview, setNarrationDragPreview] = useState<number | null>(null);

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
  const captionDragRef = useRef<{ clipId: string; mode: "start" | "end" | "move"; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);
  const stillsDragRef = useRef<{ clipId: string; mode: "start" | "end" | "move"; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);
  const narrationDragRef = useRef<{ pointerStartSeconds: number; originalOffset: number } | null>(null);

  useEffect(() => {
    if (!activeVideoId) return;
    let cancelled = false;
    setError(null);
    setSelectedClip(null);
    setSelectedCaptionClip(null);

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
            setCaptionInterval(captions.intervalSeconds);
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
    if (!activeVideoId) return;
    const subjectRenderIds = (timeline?.clips ?? [])
      .filter((clip) => clip.motionPreset === "zoom-in-subject" || clip.motionPreset === "zoom-out-subject")
      .map((clip) => clip.renderId)
      .filter(Boolean) as string[];
    void Promise.all(subjectRenderIds.filter((id) => !subjectByRender[id]).map(async (id) => {
      try {
        const [x, y] = await projectsClient.detectRenderSubject(activeVideoId, id);
        setSubjectByRender((current) => ({ ...current, [id]: { x, y } }));
      } catch {
        // Leave unresolved — applyMotion falls back to frame-center until it succeeds.
      }
    }));
  }, [timeline, activeVideoId, subjectByRender]);

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
    setAnimateMode("choose");
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

  // Same for the selected caption clip, and keep the text editor in sync
  // whenever the underlying clip's text changes (including our own edits).
  useEffect(() => {
    setSelectedCaptionClip((current) => {
      if (!current || !timeline) return current;
      return timeline.captionClips.find((clip) => clip.id === current.id) ?? null;
    });
  }, [timeline]);
  useEffect(() => {
    setCaptionText(selectedCaptionClip?.text ?? "");
  }, [selectedCaptionClip?.id, selectedCaptionClip?.text]);

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
  const captionClips = [...(timeline?.captionClips ?? [])].sort((a, b) => a.startSeconds - b.startSeconds);
  const globalCaptionStyle = timeline?.captionStyle ?? {};
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

  // Mirrors the export engine's ASS burn-in (font, weight, color, outline,
  // shadow, position), scaled for legibility at the editor's small preview
  // canvas rather than an exact pixel-ratio match to the export resolution —
  // the default 22px is comfortably readable on a full 1080p export but
  // would be nearly invisible at the preview canvas's native size.
  // `activeWordIndex` (index into `text.split(/\s+/)`) recolors just that one
  // word — mirrors the export's per-word-window ASS Dialogue lines, so the
  // in-app preview matches what gets burned in.
  function drawCaptionText(
    ctx: CanvasRenderingContext2D, width: number, height: number, text: string, style: Required<CaptionStyle>,
    activeWordIndex: number | null,
  ) {
    const fontSize = Math.max(14, Math.round((style.fontSizePx / 22) * height * 0.045));
    const weight = style.bold ? 900 : 400;
    ctx.font = `${weight} ${fontSize}px "${style.fontFamily}", Arial, sans-serif`;
    ctx.textBaseline = "alphabetic";
    const maxWidth = width * 0.86;
    const words = text.split(/\s+/);
    const lines: { word: string; index: number }[][] = [];
    let line: { word: string; index: number }[] = [];
    let lineText = "";
    words.forEach((word, index) => {
      const test = lineText ? `${lineText} ${word}` : word;
      if (lineText && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = [{ word, index }];
        lineText = word;
      } else {
        line.push({ word, index });
        lineText = test;
      }
    });
    if (line.length) lines.push(line);

    const lineHeight = fontSize * 1.25;
    const blockHeight = lines.length * lineHeight;
    const margin = height * 0.05;
    let startY: number;
    if (style.position === "top") {
      startY = margin + lineHeight * 0.8;
    } else if (style.position === "middle") {
      startY = (height - blockHeight) / 2 + lineHeight * 0.8;
    } else {
      startY = height - margin - blockHeight + lineHeight * 0.8;
    }
    const outlineWidth = Math.max(1, (style.outlineWidthPx / 2) * fontSize * 0.16);
    ctx.lineJoin = "round";
    ctx.textAlign = "left";
    const highlightEnabled = style.wordHighlight.enabled && activeWordIndex !== null;
    const highlightColor = style.wordHighlight.color ?? "#FFEB3B";

    lines.forEach((lineWords, lineIndex) => {
      const y = startY + lineIndex * lineHeight;
      const fullLineText = lineWords.map((w) => w.word).join(" ");
      let x = width / 2 - ctx.measureText(fullLineText).width / 2;
      lineWords.forEach(({ word, index }, wordPos) => {
        const isActive = highlightEnabled && index === activeWordIndex;
        if (outlineWidth > 0) {
          ctx.shadowColor = "transparent";
          ctx.lineWidth = outlineWidth;
          ctx.strokeStyle = style.outlineColor;
          ctx.strokeText(word, x, y);
        }
        if (style.shadow.enabled) {
          ctx.shadowColor = "rgba(0,0,0,0.7)";
          ctx.shadowBlur = style.shadow.blur ?? 4;
          ctx.shadowOffsetX = style.shadow.offsetX ?? 0;
          ctx.shadowOffsetY = style.shadow.offsetY ?? 2;
        } else {
          ctx.shadowColor = "transparent";
        }
        ctx.fillStyle = isActive ? highlightColor : style.color;
        ctx.fillText(word, x, y);
        ctx.shadowColor = "transparent";
        const wordWithTrailingSpace = wordPos < lineWords.length - 1 ? `${word} ` : word;
        x += ctx.measureText(wordWithTrailingSpace).width;
      });
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
        const subject = clip.renderId ? subjectByRender[clip.renderId] : undefined;
        const rect = applyMotion(clip.motionPreset, elapsedSeconds, clipDuration, clip.motionIntensity, base, subject);
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
    if (caption) {
      const resolved = resolveCaptionStyle(globalCaptionStyle, caption.style);
      // Extend each word's effective window to the next word's start (or the
      // clip's end for the last one) so there's no highlight gap between
      // words — mirrors the export's per-word-window Dialogue lines exactly.
      let activeWordIndex: number | null = null;
      const words = caption.words;
      if (words && words.length) {
        const idx = words.findIndex((w, i) => {
          const effectiveEnd = i + 1 < words.length ? words[i + 1].startSeconds : caption.endSeconds;
          return time >= w.startSeconds && time < effectiveEnd;
        });
        activeWordIndex = idx >= 0 ? idx : null;
      }
      drawCaptionText(ctx, canvas.width, canvas.height, caption.text, resolved, activeWordIndex);
    }
  }
  drawFrameRef.current = drawFrame;

  useEffect(() => {
    drawFrameRef.current(previewTimeRef.current);
  }, [stillsClips, captionClips, globalCaptionStyle, renderUrls, videoAssetUrls, canvasSize, subjectByRender]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  function stepFrame() {
    const audio = audioRef.current;
    const narrationOffset = timeline?.narrationOffsetSeconds ?? 0;
    let t = previewTimeRef.current;
    if (audio && audioDataUrl && !audio.paused) {
      t = audio.currentTime + narrationOffset;
      if (audio.ended) {
        pausePreview();
        return;
      }
    } else if (playStartRef.current) {
      t = playStartRef.current.timeStart + (performance.now() - playStartRef.current.wallStart) / 1000;
      // Narration hasn't started yet (still inside its lead-in offset) — keep
      // advancing on the wall clock until we cross into its range, then hand
      // off to the audio element so the two stay in lockstep from there on.
      if (audio && audioDataUrl && t >= narrationOffset) {
        audio.currentTime = Math.max(0, t - narrationOffset);
        void audio.play();
        playStartRef.current = null;
      }
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
    const narrationOffset = timeline?.narrationOffsetSeconds ?? 0;
    if (audioRef.current && audioDataUrl && startAt >= narrationOffset) {
      audioRef.current.currentTime = startAt - narrationOffset;
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
    const narrationOffset = timeline?.narrationOffsetSeconds ?? 0;
    const pastOffset = clamped >= narrationOffset;
    if (audioRef.current && audioDataUrl && pastOffset) {
      audioRef.current.currentTime = clamped - narrationOffset;
      if (isPlayingRef.current) {
        void audioRef.current.play();
        playStartRef.current = null;
      }
    } else if (audioRef.current && audioDataUrl) {
      audioRef.current.pause();
    }
    if (isPlayingRef.current && (!audioRef.current || !audioDataUrl || !pastOffset)) {
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

  // Shared move/resize math for both the stills and captions lanes: edge
  // handles clamp to the clip's own opposite edge (a minimum 0.1s length),
  // while a body drag shifts both edges by the same delta so the clip's own
  // duration never changes — only its position on the timeline does.
  function nextDragBounds(
    mode: "start" | "end" | "move",
    originalStart: number,
    originalEnd: number,
    pointerStartSeconds: number,
    time: number,
  ): { start: number; end: number } {
    if (mode === "start") {
      return { start: Math.max(0, Math.min(time, originalEnd - 0.1)), end: originalEnd };
    }
    if (mode === "end") {
      return { start: originalStart, end: Math.max(originalStart + 0.1, time) };
    }
    const delta = time - pointerStartSeconds;
    const duration = originalEnd - originalStart;
    const start = Math.max(0, originalStart + delta);
    return { start, end: start + duration };
  }

  function onDragPointerMove(event: ReactPointerEvent) {
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (playheadDragRef.current) {
      seekPreview(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
      return;
    }
    const time = pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond);
    const captionDrag = captionDragRef.current;
    if (captionDrag) {
      setCaptionDragPreview((current) => {
        if (!current || current.clipId !== captionDrag.clipId) return current;
        return { clipId: current.clipId, ...nextDragBounds(captionDrag.mode, captionDrag.originalStart, captionDrag.originalEnd, captionDrag.pointerStartSeconds, time) };
      });
    }
    const stillsDrag = stillsDragRef.current;
    if (stillsDrag) {
      setStillsDragPreview((current) => {
        if (!current || current.clipId !== stillsDrag.clipId) return current;
        return { clipId: current.clipId, ...nextDragBounds(stillsDrag.mode, stillsDrag.originalStart, stillsDrag.originalEnd, stillsDrag.pointerStartSeconds, time) };
      });
    }
    const narrationDrag = narrationDragRef.current;
    if (narrationDrag) {
      const delta = time - narrationDrag.pointerStartSeconds;
      setNarrationDragPreview(Math.max(0, narrationDrag.originalOffset + delta));
    }
  }

  function beginCaptionDrag(clip: TimelineCaptionClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    const pointerStartSeconds = rect ? pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond) : clip.startSeconds;
    captionDragRef.current = { clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setCaptionDragPreview({ clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  function beginStillsDrag(clip: TimelineClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    const pointerStartSeconds = rect ? pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond) : clip.startSeconds;
    stillsDragRef.current = { clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setStillsDragPreview({ clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  function beginNarrationDrag(event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    const pointerStartSeconds = rect ? pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond) : 0;
    narrationDragRef.current = { pointerStartSeconds, originalOffset: timeline?.narrationOffsetSeconds ?? 0 };
    setNarrationDragPreview(timeline?.narrationOffsetSeconds ?? 0);
  }

  function endDrag() {
    playheadDragRef.current = false;
    const captionDrag = captionDragRef.current;
    if (captionDrag) {
      captionDragRef.current = null;
      setCaptionDragPreview((preview) => {
        if (activeVideoId && preview && preview.clipId === captionDrag.clipId
          && (preview.start !== captionDrag.originalStart || preview.end !== captionDrag.originalEnd)) {
          void refresh(projectsClient.updateTimelineCaptionClip(activeVideoId, captionDrag.clipId, preview.start, preview.end));
        }
        return null;
      });
    }
    const stillsDrag = stillsDragRef.current;
    if (stillsDrag) {
      stillsDragRef.current = null;
      setStillsDragPreview((preview) => {
        if (activeVideoId && preview && preview.clipId === stillsDrag.clipId
          && (preview.start !== stillsDrag.originalStart || preview.end !== stillsDrag.originalEnd)) {
          void refresh(projectsClient.updateTimelineClip(activeVideoId, stillsDrag.clipId, preview.start, preview.end));
        }
        return null;
      });
    }
    const narrationDrag = narrationDragRef.current;
    if (narrationDrag) {
      narrationDragRef.current = null;
      setNarrationDragPreview((preview) => {
        if (activeVideoId && preview !== null && preview !== narrationDrag.originalOffset) {
          void refresh(projectsClient.setNarrationOffset(activeVideoId, preview));
        }
        return null;
      });
    }
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
      // Probing spawns a real ffmpeg process and can take a couple of seconds —
      // the button stays disabled with a spinner for that whole window so a
      // single click isn't mistaken for a no-op and clicked again.
      let duration = totalDuration;
      try {
        duration = await projectsClient.probeNarrationDuration(activeVideoId);
      } catch {
        // No narration audio yet, or the probe failed — fall back rather than
        // blocking the action entirely.
      }
      await refresh(projectsClient.extrapolateStillsToFillGaps(activeVideoId, duration));
      addToast("Stills stretched to close every gap.", "success");
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
    setInspectorTab("captions");
  }

  async function commitCaptionText() {
    if (!activeVideoId || !selectedCaptionClip) return;
    const trimmed = captionText.trim();
    if (!trimmed || trimmed === selectedCaptionClip.text) return;
    await refresh(projectsClient.updateCaptionClipText(activeVideoId, selectedCaptionClip.id, trimmed));
  }

  async function deleteCaptionClip() {
    if (!activeVideoId || !selectedCaptionClip) return;
    await refresh(projectsClient.deleteTimelineCaptionClip(activeVideoId, selectedCaptionClip.id));
    setSelectedCaptionClip(null);
  }

  async function splitCaptionClipAtPlayhead() {
    if (!activeVideoId || !selectedCaptionClip) return;
    const { startSeconds, endSeconds, text } = selectedCaptionClip;
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
    await refresh(projectsClient.splitCaptionClip(activeVideoId, selectedCaptionClip.id, previewTime, leftText, rightText));
  }

  async function mergeCaptionClipWithNext() {
    if (!activeVideoId || !selectedCaptionClip) return;
    const next = captionClips.find((clip) => Math.abs(clip.startSeconds - selectedCaptionClip.endSeconds) < 0.01);
    if (!next) return;
    await refresh(projectsClient.mergeCaptionClips(activeVideoId, selectedCaptionClip.id, next.id));
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

  async function generateAnimation() {
    if (!activeVideoId || !selectedClip || selectedClip.clipKind !== "still") return;
    try {
      setError(null);
      setAnimationJob(await projectsClient.createAnimationJob(activeVideoId, selectedClip.id, animationResolution, animationPrompt));
    } catch (caught) {
      setError(String(caught));
    }
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
          <p className="eyebrow">Timeline</p>
          <h1>Editor</h1>
          <p>Arrange your stills and preview the finished video — captions and narration stay perfectly synced automatically.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary" onClick={() => setExportModal("project")} disabled={!timeline.clips.length}><Sparkles size={16} />Export project</button>
          <button className="primary" onClick={() => setExportModal("video")} disabled={!timeline.clips.length}><Download size={16} />Export video</button>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {confirmResetTimeline && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmResetTimeline(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Reset timeline</p>
            <h2>Reset everything to default?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This discards the current still order, timing, camera movement, transitions, caption edits and styles,
              and narration sync, then rebuilds the timeline fresh from the visual plan and captions. This can't be undone.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmResetTimeline(false)}>Cancel</button>
              <button className="primary" onClick={() => { setConfirmResetTimeline(false); void resetTimelineToDefault(); }}>Reset</button>
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
              <button className="primary" onClick={() => { setConfirmRegenerateCaptions(false); void runCaptionGeneration(); }}>Regenerate</button>
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
          <aside className="tl-media-pane">
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
              <button className={inspectorTab === "captions" ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setInspectorTab("captions")}>Captions</button>
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
                  <button className="secondary" disabled={extrapolating} onClick={() => void extrapolateStills()}>
                    {extrapolating ? <><LoaderCircle className="spin" size={14} />Closing gaps…</> : <><Move size={14} />Extrapolate stills to fill gaps</>}
                  </button>
                  <p className="tl-source-hint">
                    Stretches every still to close gaps between them (from silence between sentences), so they tile
                    back-to-back — this is what makes transitions actually visible.
                  </p>
                </div>
                <div className="tl-inspector-group">
                  <button className="secondary danger-action" onClick={() => void removeAllEffects()}><Trash2 size={14} />Remove all effects</button>
                </div>
                <div className="tl-inspector-group">
                  <button className="secondary danger-action" disabled={resettingTimeline} onClick={() => setConfirmResetTimeline(true)}>
                    {resettingTimeline ? <LoaderCircle className="spin" size={14} /> : <Undo2 size={14} />}Reset timeline to default
                  </button>
                  <p className="tl-source-hint">
                    Discards every customization — still order, timing, camera movement, transitions, caption edits and
                    styles, and narration sync — and rebuilds the timeline from scratch.
                  </p>
                </div>
              </div>
            )}
            {inspectorTab === "captions" && (
              <div className="tl-inspector">
                {selectedCaptionClip ? (
                  <>
                    <div className="tl-inspector-header">
                      <button className="tl-apply-all-btn" style={{ alignSelf: "flex-start" }} onClick={() => setSelectedCaptionClip(null)}>← Back</button>
                      <strong><Type size={14} />Caption</strong>
                      <span>{formatTime(selectedCaptionClip.startSeconds)} – {formatTime(selectedCaptionClip.endSeconds)}</span>
                    </div>
                    <div className="tl-inspector-group">
                      <span className="tl-inspector-label">Text</span>
                      <textarea
                        className="tl-prompt-textarea"
                        rows={3}
                        value={captionText}
                        onChange={(event) => setCaptionText(event.target.value)}
                        onBlur={() => void commitCaptionText()}
                      />
                      <div className="tl-preset-grid two">
                        <button
                          className="secondary"
                          disabled={previewTime <= selectedCaptionClip.startSeconds || previewTime >= selectedCaptionClip.endSeconds}
                          onClick={() => void splitCaptionClipAtPlayhead()}
                        >
                          <Scissors size={14} />Split at playhead
                        </button>
                        <button
                          className="secondary"
                          disabled={!captionClips.some((clip) => Math.abs(clip.startSeconds - selectedCaptionClip.endSeconds) < 0.01)}
                          onClick={() => void mergeCaptionClipWithNext()}
                        >
                          Merge with next
                        </button>
                      </div>
                      <button className="secondary danger-action" onClick={() => void deleteCaptionClip()}><Trash2 size={14} />Delete caption</button>
                    </div>
                    <div className="tl-inspector-group">
                      <div className="tl-inspector-label-row">
                        <span className="tl-inspector-label">Style override</span>
                        {selectedCaptionClip.style && (
                          <button className="tl-apply-all-btn" onClick={() => void updateSelectedCaptionStyle(null)}>Reset to default</button>
                        )}
                      </div>
                      {!selectedCaptionClip.style && <p className="tl-source-hint">Inheriting the global default — adjust anything below to customize just this caption.</p>}
                      {!selectedCaptionClip.words?.length && (
                        <p className="tl-source-hint">
                          No original narration timing on this caption (it was hand-edited or added manually) — word
                          highlight won't apply here even if turned on; the whole caption stays one color.
                        </p>
                      )}
                      <CaptionStyleEditor
                        style={resolveCaptionStyle(globalCaptionStyle, selectedCaptionClip.style)}
                        onChange={(patch) => void updateSelectedCaptionStyle({ ...(selectedCaptionClip.style ?? {}), ...patch })}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="tl-inspector-group">
                      <span className="tl-inspector-label">Generate</span>
                      <label className="caption-interval" title="Maximum seconds of narration per caption">
                        <span>Window</span>
                        <input
                          type="number" min="0.2" max="5" step="0.1"
                          value={captionInterval} disabled={generatingCaptions}
                          onChange={(event) => setCaptionInterval(Number(event.target.value))}
                        />
                        <span>sec</span>
                      </label>
                      <button className="secondary full" disabled={generatingCaptions} onClick={generateCaptions}>
                        {generatingCaptions ? <><LoaderCircle className="spin" size={16} />Generating…</> : <><Type size={16} />{captionSet ? "Regenerate captions" : "Generate captions"}</>}
                      </button>
                      <button className="secondary full" disabled={!captionSet} onClick={() => void saveCaptionsAs()}><Download size={16} />Save captions as…</button>
                    </div>
                    <div className="tl-inspector-group">
                      <button className="secondary full" onClick={() => void addCaptionAtPlayhead()}><Plus size={14} />Add caption at playhead</button>
                      <p className="tl-source-hint">Select a caption on the lane below to edit, retime, split, merge, or style it individually.</p>
                    </div>
                    <div className="tl-inspector-group">
                      <span className="tl-inspector-label">Global default style</span>
                      <p className="tl-source-hint">Applies to every caption that hasn't been given its own style override.</p>
                      <CaptionStyleEditor
                        style={resolveCaptionStyle(globalCaptionStyle, null)}
                        onChange={(patch) => void updateGlobalCaptionStyle({ ...globalCaptionStyle, ...patch })}
                      />
                    </div>
                  </>
                )}
              </div>
            )}
            {inspectorTab === "clip" && (selectedClip ? (
              <div className="tl-inspector">
                <div className="tl-inspector-header">
                  <strong>{selectedClip.clipKind === "animation" ? "Animated" : "Still"}</strong>
                  <span>{formatTime(selectedClip.startSeconds)} – {formatTime(selectedClip.endSeconds)}</span>
                  {selectedClip.clipKind === "animation" && selectedClipVideoAsset && (
                    <span className={Math.abs(selectedClipVideoAsset.actualDurationSeconds - (selectedClip.endSeconds - selectedClip.startSeconds)) > 0.05 ? "tl-duration-pill mismatch" : "tl-duration-pill fit"}>
                      {Math.abs(selectedClipVideoAsset.actualDurationSeconds - (selectedClip.endSeconds - selectedClip.startSeconds)) > 0.05 ? "Duration mismatch" : "Fits slot"}
                    </span>
                  )}
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
                <div className="tl-inspector-group">
                  <span className="tl-inspector-label"><Clapperboard size={12} />Animate this clip</span>

                  {selectedClip.clipKind === "still" && !selectedClip.videoAssetId && animateMode === "choose" && (
                    <>
                      <button className="primary tl-generate-btn" onClick={() => setAnimateMode("generate")}>
                        <Clapperboard size={14} />Generate
                      </button>
                      <p className="tl-source-hint">
                        Generates motion with Veo from a prompt, automatically stretched or trimmed to exactly fill
                        this {formatTime(selectedClip.endSeconds - selectedClip.startSeconds)} slot.
                      </p>
                      <button className="tl-upload-secondary" disabled={uploadingAnimation} onClick={() => void uploadAnimation()}>
                        <Upload size={12} />{uploadingAnimation ? "Uploading…" : "Or upload your own clip instead"}
                      </button>
                    </>
                  )}

                  {selectedClip.clipKind === "still" && !selectedClip.videoAssetId && animateMode === "generate" && (
                    <>
                      <button className="tl-apply-all-btn" style={{ alignSelf: "flex-start" }} onClick={() => setAnimateMode("choose")}>← Back</button>
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
                        Veo only generates 4s, 6s, or 8s clips — this will generate as{" "}
                        {pickVeoDuration(selectedClip.endSeconds - selectedClip.startSeconds)}s. Use "Adjust animation to
                        duration" afterward to stretch it to exactly fill this {formatTime(selectedClip.endSeconds - selectedClip.startSeconds)} slot.
                      </p>
                      <button className="primary full" onClick={() => void generateAnimation()}>
                        <Clapperboard size={14} />Generate Animation
                      </button>
                    </>
                  )}

                  {selectedClip.clipKind === "animation" && (
                    <>
                      <p className="tl-source-hint tl-prompt-readout">
                        {selectedClipVideoAsset?.prompt ? selectedClipVideoAsset.prompt : "(no prompt — Veo decided the motion on its own)"}
                      </p>
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
                      <button className="secondary" onClick={() => void undoAnimation()}>
                        <Undo2 size={14} />Undo animation
                      </button>
                      <p className="tl-source-hint">
                        Reverts to the still. The generated animation stays cached — restore it any time, unless
                        you generate or upload a new one first.
                      </p>
                    </>
                  )}

                  {selectedClip.clipKind === "still" && selectedClip.videoAssetId && (
                    <>
                      <button className="secondary" onClick={() => void restoreAnimation()}>
                        <Redo2 size={14} />Restore cached animation
                      </button>
                      <p className="tl-source-hint">A previously generated animation for this still is cached and ready to bring back.</p>
                    </>
                  )}
                </div>
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
                  {audioDataUrl && (
                    <div
                      className="tl-narration-offset"
                      style={{ left: secondsToPixels(narrationDragPreview ?? timeline?.narrationOffsetSeconds ?? 0, pixelsPerSecond) }}
                      onPointerDown={beginNarrationDrag}
                      title="Drag to shift when narration starts"
                    >
                      <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={setNarrationDuration} />
                    </div>
                  )}
                  {!audioDataUrl && <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={setNarrationDuration} />}
                </div>
                <div className="tl-lane-track" style={{ height: STILLS_LANE_HEIGHT }}>
                  {stillsClips.map((clip) => {
                    const isDragging = stillsDragPreview?.clipId === clip.id;
                    const start = isDragging ? stillsDragPreview.start : clip.startSeconds;
                    const end = isDragging ? stillsDragPreview.end : clip.endSeconds;
                    return (
                      <div
                        key={clip.id}
                        className={selectedClip?.id === clip.id ? "tl-clip tl-clip-stills active" : "tl-clip tl-clip-stills"}
                        style={{ left: secondsToPixels(start, pixelsPerSecond), width: Math.max(4, secondsToPixels(end - start, pixelsPerSecond)) }}
                        onPointerDown={(event) => beginStillsDrag(clip, "move", event)}
                        onClick={(event) => { event.stopPropagation(); seekPreview(clip.startSeconds); }}
                      >
                        <div className="tl-clip-resize-handle left" onPointerDown={(event) => beginStillsDrag(clip, "start", event)} />
                        {clip.renderId && renderUrls[clip.renderId] ? <img src={renderUrls[clip.renderId]} alt="" draggable={false} /> : <span className="tl-clip-fallback">{clip.label}</span>}
                        {clip.transitionIn === "fade" && <span className="tl-clip-badge tl-clip-badge-fade" title="Fade in"><Sparkles size={10} /></span>}
                        {clip.motionPreset !== "none" && <span className="tl-clip-badge tl-clip-badge-motion" title={`Camera: ${motionLabel(clip.motionPreset)}`}><Move size={10} /></span>}
                        {clip.clipKind === "animation" && <span className="tl-clip-badge tl-clip-badge-animation" title="Animated with Veo"><Clapperboard size={10} /></span>}
                        <div className="tl-clip-resize-handle right" onPointerDown={(event) => beginStillsDrag(clip, "end", event)} />
                      </div>
                    );
                  })}
                </div>
                <div className="tl-lane-track tl-captions-track" style={{ height: CAPTIONS_LANE_HEIGHT }}>
                  {captionClips.map((clip) => {
                    const isDragging = captionDragPreview?.clipId === clip.id;
                    const start = isDragging ? captionDragPreview.start : clip.startSeconds;
                    const end = isDragging ? captionDragPreview.end : clip.endSeconds;
                    const clipWidth = Math.max(3, secondsToPixels(end - start, pixelsPerSecond));
                    const isSelected = selectedCaptionClip?.id === clip.id;
                    return (
                      <div
                        key={clip.id}
                        className={[
                          "tl-clip", "tl-clip-captions",
                          isSelected ? "active" : "",
                          clipWidth < 46 ? "narrow" : "",
                        ].filter(Boolean).join(" ")}
                        style={{ left: secondsToPixels(start, pixelsPerSecond), width: clipWidth }}
                        title={clip.text}
                        onPointerDown={(event) => beginCaptionDrag(clip, "move", event)}
                        onClick={(event) => { event.stopPropagation(); selectCaptionClip(clip); seekPreview(clip.startSeconds); }}
                      >
                        <div className="tl-clip-resize-handle left" onPointerDown={(event) => beginCaptionDrag(clip, "start", event)} />
                        {clipWidth >= 46 && <span className="tl-clip-text">{clip.text}</span>}
                        <div className="tl-clip-resize-handle right" onPointerDown={(event) => beginCaptionDrag(clip, "end", event)} />
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

function CaptionStyleEditor({
  style,
  onChange,
}: {
  style: Required<CaptionStyle>;
  onChange: (patch: Partial<CaptionStyle>) => void;
}) {
  return (
    <div className="tl-caption-style-editor">
      <div className="tl-preset-grid two">
        {CAPTION_STYLE_PRESETS.map((preset) => (
          <button key={preset.label} className="tl-preset-btn" onClick={() => onChange(preset.style)}>{preset.label}</button>
        ))}
      </div>
      <label className="tl-style-field">
        <span>Font</span>
        <select value={style.fontFamily} onChange={(event) => onChange({ fontFamily: event.target.value })}>
          {CAPTION_FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
        </select>
      </label>
      <label className="tl-style-field">
        <span>Size <b>{style.fontSizePx}px</b></span>
        <input type="range" className="tl-slider" min={14} max={48} step={1} value={style.fontSizePx} onChange={(event) => onChange({ fontSizePx: Number(event.target.value) })} />
      </label>
      <label className="tl-style-field tl-style-checkbox">
        <input type="checkbox" checked={style.bold} onChange={(event) => onChange({ bold: event.target.checked })} />
        <span>Bold</span>
      </label>
      <label className="tl-style-field">
        <span>Color</span>
        <input type="color" value={style.color} onChange={(event) => onChange({ color: event.target.value })} />
      </label>
      <label className="tl-style-field">
        <span>Outline color</span>
        <input type="color" value={style.outlineColor} onChange={(event) => onChange({ outlineColor: event.target.value })} />
      </label>
      <label className="tl-style-field">
        <span>Outline width <b>{style.outlineWidthPx}px</b></span>
        <input type="range" className="tl-slider" min={0} max={6} step={1} value={style.outlineWidthPx} onChange={(event) => onChange({ outlineWidthPx: Number(event.target.value) })} />
      </label>
      <label className="tl-style-field tl-style-checkbox">
        <input type="checkbox" checked={style.shadow.enabled} onChange={(event) => onChange({ shadow: { ...style.shadow, enabled: event.target.checked } })} />
        <span>Shadow</span>
      </label>
      {style.shadow.enabled && (
        <>
          <label className="tl-style-field">
            <span>Shadow blur <b>{style.shadow.blur}</b></span>
            <input type="range" className="tl-slider" min={0} max={12} step={1} value={style.shadow.blur} onChange={(event) => onChange({ shadow: { ...style.shadow, blur: Number(event.target.value) } })} />
          </label>
          <label className="tl-style-field">
            <span>Shadow offset X <b>{style.shadow.offsetX}</b></span>
            <input type="range" className="tl-slider" min={-8} max={8} step={1} value={style.shadow.offsetX} onChange={(event) => onChange({ shadow: { ...style.shadow, offsetX: Number(event.target.value) } })} />
          </label>
          <label className="tl-style-field">
            <span>Shadow offset Y <b>{style.shadow.offsetY}</b></span>
            <input type="range" className="tl-slider" min={-8} max={8} step={1} value={style.shadow.offsetY} onChange={(event) => onChange({ shadow: { ...style.shadow, offsetY: Number(event.target.value) } })} />
          </label>
        </>
      )}
      <div className="tl-style-field">
        <span>Position</span>
        <div className="tl-preset-grid three">
          {(["top", "middle", "bottom"] as const).map((position) => (
            <button
              key={position}
              className={style.position === position ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => onChange({ position })}
            >
              {position}
            </button>
          ))}
        </div>
      </div>
      <label className="tl-style-field tl-style-checkbox">
        <input
          type="checkbox"
          checked={style.wordHighlight.enabled}
          onChange={(event) => onChange({ wordHighlight: { ...style.wordHighlight, enabled: event.target.checked } })}
        />
        <span>Highlight the word being spoken</span>
      </label>
      {style.wordHighlight.enabled && (
        <label className="tl-style-field">
          <span>Highlight color</span>
          <input
            type="color"
            value={style.wordHighlight.color}
            onChange={(event) => onChange({ wordHighlight: { ...style.wordHighlight, color: event.target.value } })}
          />
        </label>
      )}
    </div>
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

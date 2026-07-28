import { useEffect, useRef, useState, type RefObject } from "react";
import { secondsToPixels } from "../domain/timecode";
import type { CaptionStyle, TimelineCaptionClipRecord, TimelineClipRecord, TimelineRecord } from "../infrastructure/projects-client";
import {
  buildColorFilterCss,
  drawCaptionText,
  drawJoinTransitionFrame,
  drawStillClipContent,
  fadeOverlay,
  findClipAtTime,
  joinTransitionSeconds,
  JOIN_TRANSITIONS,
  resolveCaptionStyle,
} from "./timeline-rendering";

/** Owns playback time (play/pause/seek/step), the requestAnimationFrame
 * loop, keeping the `<audio>` element in lockstep with it, and drawing each
 * frame of the preview canvas. This is the busiest piece of the Editor —
 * drawing a frame legitimately needs the current clips, caption state,
 * every resolved asset URL, and the canvas itself, so its dependency list is
 * long by nature rather than by accident. */
export function useTimelinePlayback(params: {
  timeline: TimelineRecord | null;
  stillsClips: TimelineClipRecord[];
  captionClips: TimelineCaptionClipRecord[];
  totalDuration: number;
  canvasSize: { width: number; height: number };
  renderUrls: Record<string, string>;
  videoAssetUrls: Record<string, string>;
  subjectByRender: Record<string, { x: number; y: number }>;
  getImageByRenderId: (renderId: string) => HTMLImageElement | null;
  getSubjectByRenderId: (renderId: string) => { x: number; y: number } | undefined;
  getOrLoadVideo: (url: string) => HTMLVideoElement;
  effectiveGlobalCaptionStyle: CaptionStyle;
  pendingSelectedCaptionStyle: CaptionStyle | null | undefined;
  selectedCaptionClip: TimelineCaptionClipRecord | null;
  audioDataUrl: string | null;
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  pixelsPerSecond: number;
  /** Called on every step/seek so the caller can keep clip selection synced
   * to the playhead (`updateSelectionForTime` in the original component). */
  onTimeChange?: (time: number) => void;
}) {
  const {
    timeline, stillsClips, captionClips, totalDuration, canvasSize,
    renderUrls, videoAssetUrls, subjectByRender, getImageByRenderId, getSubjectByRenderId, getOrLoadVideo,
    effectiveGlobalCaptionStyle, pendingSelectedCaptionStyle, selectedCaptionClip, audioDataUrl,
    previewCanvasRef, audioRef, canvasScrollRef, pixelsPerSecond, onTimeChange,
  } = params;

  const [previewTime, setPreviewTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const previewTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playStartRef = useRef<{ wallStart: number; timeStart: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawFrameRef = useRef<(time: number) => void>(() => {});
  const activeVideoElRef = useRef<HTMLVideoElement | null>(null);
  const activeAnimationAssetIdRef = useRef<string | null>(null);
  // A long-running play session keeps re-invoking the same `stepFrame`
  // closure (see its own comment below) — indirecting through a ref here,
  // the same trick `drawFrameRef` uses, means the *latest* stillsClips
  // (closed over inside whatever `onTimeChange` the current render passed
  // in) is what actually runs, not whatever was current when playback started.
  const onTimeChangeRef = useRef(onTimeChange);
  useEffect(() => { onTimeChangeRef.current = onTimeChange; });

  useEffect(() => { previewTimeRef.current = previewTime; }, [previewTime]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

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
          ctx.filter = buildColorFilterCss(clip.colorFilterPreset, clip.colorFilterIntensity);
          ctx.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
          ctx.filter = "none";
          drewVideoFrame = true;
          const clipDuration = clip.endSeconds - clip.startSeconds;
          const { alpha: overlayAlpha, color: overlayColor } = fadeOverlay(clip.transitionIn, clip.transitionOut, elapsedSeconds, clipDuration);
          if (overlayAlpha > 0) {
            ctx.globalAlpha = overlayAlpha;
            ctx.fillStyle = overlayColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    if (!drewVideoFrame && clip?.renderId) {
      // Clamp to 0 rather than going negative during the leading-gap
      // fallback (time before this clip's own start) — freezes on the
      // clip's first frame instead of extrapolating zoom/fade backwards.
      const elapsedSeconds = Math.max(0, time - clip.startSeconds);
      const clipDuration = clip.endSeconds - clip.startSeconds;
      const clipIndex = stillsClips.indexOf(clip);
      const nextClip = clipIndex >= 0 ? stillsClips[clipIndex + 1] : undefined;
      // Join-transition preview is a deliberately simplified approximation of
      // what export actually produces — only offered between two plain still
      // images, both here and in expand_join_transitions's own "image"-only
      // gate on the export side.
      const canJoin = nextClip
        && (clip.clipKind === "still" || clip.clipKind === "imported-still")
        && (nextClip.clipKind === "still" || nextClip.clipKind === "imported-still")
        && JOIN_TRANSITIONS.has(clip.transitionOut)
        && Math.abs(nextClip.startSeconds - clip.endSeconds) < 0.05;
      const transitionSeconds = canJoin && nextClip
        ? joinTransitionSeconds(clipDuration, nextClip.endSeconds - nextClip.startSeconds)
        : 0;
      const inJoinWindow = canJoin && transitionSeconds > 0 && elapsedSeconds >= clipDuration - transitionSeconds;

      if (inJoinWindow && nextClip) {
        const progress = Math.max(0, Math.min(1, (elapsedSeconds - (clipDuration - transitionSeconds)) / transitionSeconds));
        drawJoinTransitionFrame(ctx, canvas, clip, nextClip, elapsedSeconds, progress * transitionSeconds, progress, clip.transitionOut, getImageByRenderId, getSubjectByRenderId);
      } else if (drawStillClipContent(ctx, canvas, clip, elapsedSeconds, getImageByRenderId, getSubjectByRenderId)) {
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
        const { alpha: overlayAlpha, color: overlayColor } = fadeOverlay(effectiveTransitionIn, effectiveTransitionOut, elapsedSeconds, clipDuration);
        if (overlayAlpha > 0) {
          ctx.globalAlpha = overlayAlpha;
          ctx.fillStyle = overlayColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }
      }
    }
    const caption = captionClips.find((c) => time >= c.startSeconds && time < c.endSeconds);
    if (caption) {
      const isEditingThisCaption = selectedCaptionClip?.id === caption.id && pendingSelectedCaptionStyle !== undefined;
      const captionStyleOverride = isEditingThisCaption ? pendingSelectedCaptionStyle : caption.style;
      const resolved = resolveCaptionStyle(effectiveGlobalCaptionStyle, captionStyleOverride);
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
  }, [stillsClips, captionClips, effectiveGlobalCaptionStyle, pendingSelectedCaptionStyle, selectedCaptionClip, renderUrls, videoAssetUrls, canvasSize, subjectByRender]);

  useEffect(() => {
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  function updateSelectionForTime(time: number) {
    onTimeChangeRef.current?.(time);
  }

  function pausePreview() {
    isPlayingRef.current = false;
    setIsPlaying(false);
    audioRef.current?.pause();
    activeVideoElRef.current?.pause();
    playStartRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }

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

  return {
    previewTime,
    previewTimeRef,
    isPlaying,
    isPlayingRef,
    playPreview,
    pausePreview,
    seekPreview,
    scrollTimelineToTime,
    drawFrameRef,
  };
}

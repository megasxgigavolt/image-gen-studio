import { useEffect, useRef, useState, type RefObject } from "react";
import { secondsToPixels } from "../domain/timecode";
import { parseMotionRecipe, type CaptionStyle, type TimelineCaptionClipRecord, type TimelineClipRecord, type TimelineMusicClipRecord, type TimelineRecord } from "../infrastructure/projects-client";
import {
  applyMotion,
  applyMotionRecipe,
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
  mediaAssetUrls: Record<string, string>;
  subjectByRender: Record<string, { x: number; y: number }>;
  getImageByAssetId: (assetId: string) => HTMLImageElement | null;
  getSubjectByRenderId: (renderId: string) => { x: number; y: number } | undefined;
  getOrLoadVideo: (url: string) => HTMLVideoElement;
  getOrLoadAudio: (url: string) => HTMLAudioElement;
  effectiveGlobalCaptionStyle: CaptionStyle;
  pendingSelectedCaptionStyle: CaptionStyle | null | undefined;
  selectedCaptionClip: TimelineCaptionClipRecord | null;
  audioDataUrl: string | null;
  previewCanvasRef: RefObject<HTMLCanvasElement | null>;
  audioRef: RefObject<HTMLAudioElement | null>;
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  pixelsPerSecond: number;
  /** The whole music track, sorted — live-previewed here the same way a
   * generated animation clip's own video element is (one active element at
   * a time, switched as the playhead crosses clip boundaries). Volume is
   * recomputed every frame from the clip's own volume, the master volume/
   * duck-sensitivity sliders, and fade in/out — mirroring
   * build_timeline_export_manifest's math exactly so preview and export
   * agree on what the mix sounds like. */
  musicClips: TimelineMusicClipRecord[];
  musicMasterVolumePercent: number;
  musicDuckSensitivityPercent: number;
  /** Narration's audible span (offset through offset+duration, already
   * net of trim) — auto-duck only applies to a clip while the playhead
   * sits inside this window, matching export's own overlap computation. */
  narrationStart: number;
  narrationEnd: number;
  /** Called on every step/seek so the caller can keep clip selection synced
   * to the playhead (`updateSelectionForTime` in the original component). */
  onTimeChange?: (time: number) => void;
}) {
  const {
    timeline, stillsClips, captionClips, totalDuration, canvasSize,
    renderUrls, videoAssetUrls, mediaAssetUrls, subjectByRender, getImageByAssetId, getSubjectByRenderId, getOrLoadVideo, getOrLoadAudio,
    effectiveGlobalCaptionStyle, pendingSelectedCaptionStyle, selectedCaptionClip, audioDataUrl,
    previewCanvasRef, audioRef, canvasScrollRef, pixelsPerSecond,
    musicClips, musicMasterVolumePercent, musicDuckSensitivityPercent, narrationStart, narrationEnd, onTimeChange,
  } = params;

  const [previewTime, setPreviewTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const previewTimeRef = useRef(0);
  const isPlayingRef = useRef(false);
  const playStartRef = useRef<{ wallStart: number; timeStart: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const drawFrameRef = useRef<(time: number, forceMusicResync?: boolean) => void>(() => {});
  const activeVideoElRef = useRef<HTMLVideoElement | null>(null);
  const activeAnimationAssetIdRef = useRef<string | null>(null);
  const activeMusicElRef = useRef<HTMLAudioElement | null>(null);
  const activeMusicClipIdRef = useRef<string | null>(null);
  // Throttles how often a playing rAF tick pushes previewTime into React
  // state (and everything that cascades from it: clip-selection sync,
  // auto-scroll, and — the expensive part — a full re-render of every clip
  // and caption block in TimelineTracks, which isn't memoized against a
  // per-frame prop). The canvas preview itself still redraws every tick via
  // drawFrameRef below, so playback stays visually smooth; only the
  // React-side timeline UI updates at a lower, still-fluid cadence. Without
  // this, a caption-dense project can't finish reconciling one frame's
  // worth of DOM before the next rAF tick requests another, and the render
  // thread never catches up — see the "Editor gets stuck while playing" bug.
  const lastReactSyncRef = useRef(0);
  const REACT_SYNC_INTERVAL_MS = 66; // ~15/sec
  // A long-running play session keeps re-invoking the same `stepFrame`
  // closure (see its own comment below) — indirecting through a ref here,
  // the same trick `drawFrameRef` uses, means the *latest* stillsClips
  // (closed over inside whatever `onTimeChange` the current render passed
  // in) is what actually runs, not whatever was current when playback started.
  const onTimeChangeRef = useRef(onTimeChange);
  useEffect(() => { onTimeChangeRef.current = onTimeChange; });

  useEffect(() => { previewTimeRef.current = previewTime; }, [previewTime]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  function scrollTimelineToTime(time: number, behavior: ScrollBehavior = "smooth") {
    const container = canvasScrollRef.current;
    if (!container) return;
    const targetPx = secondsToPixels(time, pixelsPerSecond);
    const viewStart = container.scrollLeft;
    const viewEnd = viewStart + container.clientWidth;
    if (targetPx < viewStart || targetPx > viewEnd) {
      container.scrollTo({ left: Math.max(0, targetPx - container.clientWidth / 2), behavior });
    }
  }

  function drawFrame(time: number, forceMusicResync = false) {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const clip = findClipAtTime(stillsClips, time);

    // Live playback of a generated animation clip (or an imported video
    // clip, same treatment) draws real video frames; while paused/scrubbing
    // it falls through to the poster-frame path below (renderId still points
    // at the source still for every animation clip; an imported clip has no
    // poster frame of its own, so it just draws nothing while paused).
    let drewVideoFrame = false;
    const videoSourceId = clip?.clipKind === "animation" ? clip.videoAssetId
      : clip?.clipKind === "imported-clip" ? clip.mediaLibraryAssetId
      : null;
    const isVideoClip = !!videoSourceId;
    if (activeVideoElRef.current && (!isVideoClip || activeAnimationAssetIdRef.current !== videoSourceId)) {
      activeVideoElRef.current.pause();
      activeVideoElRef.current = null;
      activeAnimationAssetIdRef.current = null;
    }
    if (clip && isVideoClip && isPlayingRef.current) {
      const videoUrl = videoAssetUrls[videoSourceId as string] ?? mediaAssetUrls[videoSourceId as string];
      if (videoUrl) {
        const video = getOrLoadVideo(videoUrl);
        activeVideoElRef.current = video;
        activeAnimationAssetIdRef.current = videoSourceId as string;
        const elapsedSeconds = Math.max(0, time - clip.startSeconds);
        const clipDuration = clip.endSeconds - clip.startSeconds;
        if (Math.abs(video.currentTime - elapsedSeconds) > 0.15) {
          video.currentTime = elapsedSeconds;
        }
        if (video.paused) void video.play().catch(() => {});
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          // Cover-fill, matching drawStillClipContent's crop behavior — then
          // the exact same recipe/legacy-preset fallback chain a still
          // image goes through: a still replaced by an animation/imported
          // clip keeps whatever Camera Effect was set on it, and the rect
          // math (applyMotionRecipe/applyMotion) is source-agnostic, so it
          // applies identically to a drawn video frame.
          const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
          const base = {
            w: video.videoWidth * scale, h: video.videoHeight * scale,
            x: (canvas.width - video.videoWidth * scale) / 2, y: (canvas.height - video.videoHeight * scale) / 2,
          };
          const recipe = clip.motionGraphicSettingsJson ? parseMotionRecipe(clip.motionGraphicSettingsJson) : null;
          const recipeResult = recipe
            ? applyMotionRecipe(recipe, elapsedSeconds, clipDuration, base, canvas.width, canvas.height)
            : null;
          const rect = recipeResult ?? applyMotion(clip.motionPreset, elapsedSeconds, clipDuration, clip.motionIntensity, base);
          const colorCss = buildColorFilterCss(clip.colorFilterPreset, clip.colorFilterIntensity);
          const blurCss = recipeResult && recipeResult.blurPx > 0 ? `blur(${recipeResult.blurPx.toFixed(1)}px)` : "";
          ctx.filter = [colorCss === "none" ? "" : colorCss, blurCss].filter(Boolean).join(" ") || "none";
          ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
          ctx.filter = "none";
          drewVideoFrame = true;
          const { alpha: overlayAlpha, color: overlayColor } = fadeOverlay(clip.transitionIn, clip.transitionOut, elapsedSeconds, clipDuration, clip.transitionIntensity);
          if (overlayAlpha > 0) {
            ctx.globalAlpha = overlayAlpha;
            ctx.fillStyle = overlayColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    if (!drewVideoFrame && (clip?.renderId || clip?.mediaLibraryAssetId)) {
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
        ? joinTransitionSeconds(clipDuration, nextClip.endSeconds - nextClip.startSeconds, clip.transitionOut, clip.transitionIntensity)
        : 0;
      const inJoinWindow = canJoin && transitionSeconds > 0 && elapsedSeconds >= clipDuration - transitionSeconds;

      if (inJoinWindow && nextClip) {
        const progress = Math.max(0, Math.min(1, (elapsedSeconds - (clipDuration - transitionSeconds)) / transitionSeconds));
        drawJoinTransitionFrame(ctx, canvas, clip, nextClip, elapsedSeconds, progress * transitionSeconds, progress, clip.transitionOut, getImageByAssetId, getSubjectByRenderId);
      } else if (drawStillClipContent(ctx, canvas, clip, elapsedSeconds, getImageByAssetId, getSubjectByRenderId)) {
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
        const { alpha: overlayAlpha, color: overlayColor } = fadeOverlay(effectiveTransitionIn, effectiveTransitionOut, elapsedSeconds, clipDuration, clip.transitionIntensity);
        if (overlayAlpha > 0) {
          ctx.globalAlpha = overlayAlpha;
          ctx.fillStyle = overlayColor;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Music track — one active <audio> element at a time, switched as the
    // playhead crosses clip boundaries (same pattern as the animation-clip
    // video element above). Volume is recomputed every call from the clip's
    // own volume, the master volume/duck-sensitivity sliders, and fade in/
    // out — this is what makes those settings actually audible live instead
    // of only taking effect at export.
    const musicClip = findClipAtTime(musicClips, time);
    if (activeMusicElRef.current && activeMusicClipIdRef.current !== (musicClip?.id ?? null)) {
      activeMusicElRef.current.pause();
      activeMusicElRef.current = null;
      activeMusicClipIdRef.current = null;
    }
    if (musicClip) {
      const assetUrl = mediaAssetUrls[musicClip.mediaLibraryAssetId];
      if (assetUrl) {
        const audioEl = getOrLoadAudio(assetUrl);
        const isNewClip = activeMusicClipIdRef.current !== musicClip.id;
        const elapsedSeconds = Math.max(0, time - musicClip.startSeconds);
        if (isNewClip || forceMusicResync) {
          activeMusicElRef.current = audioEl;
          activeMusicClipIdRef.current = musicClip.id;
          audioEl.loop = musicClip.loopEnabled;
          // A looping short asset free-runs via native looping once
          // started — re-deriving its wrapped position from elapsed time
          // (which keeps growing past the asset's own duration) would
          // fight that every frame instead of just letting it play.
          audioEl.currentTime = musicClip.loopEnabled && audioEl.duration
            ? elapsedSeconds % audioEl.duration
            : elapsedSeconds;
        }
        const clipDuration = musicClip.endSeconds - musicClip.startSeconds;
        const remaining = clipDuration - elapsedSeconds;
        let volume = (musicClip.volumePercent / 100) * (musicMasterVolumePercent / 100);
        if (musicClip.fadeInEnabled && musicClip.fadeInSeconds > 0 && elapsedSeconds < musicClip.fadeInSeconds) {
          volume *= Math.max(0, elapsedSeconds / musicClip.fadeInSeconds);
        }
        if (musicClip.fadeOutEnabled && musicClip.fadeOutSeconds > 0 && remaining < musicClip.fadeOutSeconds) {
          volume *= Math.max(0, remaining / musicClip.fadeOutSeconds);
        }
        if (musicClip.autoDuck && time >= narrationStart && time < narrationEnd) {
          volume *= 1 - Math.max(0, Math.min(100, musicDuckSensitivityPercent)) / 100;
        }
        audioEl.volume = Math.max(0, Math.min(1, volume));
        if (isPlayingRef.current) {
          if (audioEl.paused) void audioEl.play().catch(() => {});
        } else if (!audioEl.paused) {
          audioEl.pause();
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
  }, [stillsClips, captionClips, effectiveGlobalCaptionStyle, pendingSelectedCaptionStyle, selectedCaptionClip, renderUrls, videoAssetUrls, mediaAssetUrls, canvasSize, subjectByRender]);

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
    activeMusicElRef.current?.pause();
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
        // A play() that a near-immediate pause() interrupts (fast pause
        // right after crossing the offset, rapid scrubbing, etc.) rejects
        // with a standard, harmless AbortError — swallow it like the
        // animation-clip video.play() below already does, so it doesn't
        // spam the console/dev overlay as an unhandled rejection.
        void audio.play().catch(() => {});
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
    drawFrameRef.current(t);
    const now = performance.now();
    if (now - lastReactSyncRef.current >= REACT_SYNC_INTERVAL_MS) {
      lastReactSyncRef.current = now;
      setPreviewTime(t);
      updateSelectionForTime(t);
      // "auto" (instant), not "smooth" — during playback this fires up to
      // REACT_SYNC_INTERVAL_MS apart, and re-triggering a smooth-scroll
      // animation that often never lets the previous one finish just piles
      // up competing scroll animations on the compositor instead of
      // tracking the playhead.
      scrollTimelineToTime(t, "auto");
    }
    if (isPlayingRef.current) rafRef.current = requestAnimationFrame(stepFrame);
  }

  function playPreview() {
    if (isPlayingRef.current || !stillsClips.length) return;
    let startAt = previewTimeRef.current;
    if (startAt >= totalDuration) startAt = 0;
    isPlayingRef.current = true;
    setIsPlaying(true);
    lastReactSyncRef.current = performance.now();
    previewTimeRef.current = startAt;
    setPreviewTime(startAt);
    const narrationOffset = timeline?.narrationOffsetSeconds ?? 0;
    if (audioRef.current && audioDataUrl && startAt >= narrationOffset) {
      audioRef.current.currentTime = startAt - narrationOffset;
      void audioRef.current.play().catch(() => {});
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
        void audioRef.current.play().catch(() => {});
        playStartRef.current = null;
      }
    } else if (audioRef.current && audioDataUrl) {
      audioRef.current.pause();
    }
    if (isPlayingRef.current && (!audioRef.current || !audioDataUrl || !pastOffset)) {
      playStartRef.current = { wallStart: performance.now(), timeStart: clamped };
    }
    drawFrameRef.current(clamped, true);
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

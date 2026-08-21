import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { pixelsToSeconds } from "../domain/timecode";
import {
  projectsClient,
  type TimelineCaptionClipRecord,
  type TimelineClipRecord,
  type TimelineLogoClipRecord,
  type TimelineMusicClipRecord,
  type TimelineRecord,
  type TimelineTextClipRecord,
} from "../infrastructure/projects-client";
import { nextDragBounds, type DragMode } from "./timeline-drag-math";

type OverlayClipRef = { id: string; startSeconds: number; endSeconds: number };

/** Owns every pointer-drag interaction on the timeline tracks: move/resize
 * for stills, captions, music, and text/logo overlays, music fade handles,
 * and the playhead itself. Narration is intentionally NOT draggable — its
 * offset is fixed once set (see TimelineTracks' narration lane, which no
 * longer wires a pointerdown handler onto the waveform). Each drag keeps a
 * live "preview" position in React state (rendered by TimelineTracks while
 * the pointer is down) and only commits to the backend — via `refresh`, so
 * it participates in undo history — once the pointer is released and the
 * position actually changed. */
export function useTimelineDrag(params: {
  activeVideoId: string | null;
  timeline: TimelineRecord | null;
  canvasInnerRef: RefObject<HTMLDivElement | null>;
  pixelsPerSecond: number;
  previewTimeRef: RefObject<number>;
  isPlayingRef: RefObject<boolean>;
  pausePreview: () => void;
  seekPreview: (time: number) => void;
  refresh: (promise: Promise<TimelineRecord>, options?: { skipHistory?: boolean }) => Promise<void>;
  stillsClips: TimelineClipRecord[];
  captionClips: TimelineCaptionClipRecord[];
  musicClips: TimelineMusicClipRecord[];
  textClips: TimelineTextClipRecord[];
  logoClips: TimelineLogoClipRecord[];
  /** Narration's own start/end on the timeline — extra snap targets for
   * stills/caption drags, alongside same-track edges and the playhead. */
  narrationStart: number;
  narrationEnd: number;
}) {
  const {
    activeVideoId, timeline, canvasInnerRef, pixelsPerSecond, previewTimeRef, isPlayingRef,
    pausePreview, seekPreview, refresh, stillsClips, captionClips, musicClips, textClips, logoClips,
    narrationStart, narrationEnd,
  } = params;

  const [captionDragPreview, setCaptionDragPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [stillsDragPreview, setStillsDragPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [musicDragPreview, setMusicDragPreview] = useState<{ clipId: string; start: number; end: number } | null>(null);
  const [overlayDragPreview, setOverlayDragPreview] = useState<{ kind: "text" | "logo"; clipId: string; start: number; end: number } | null>(null);
  const [fadeDragPreview, setFadeDragPreview] = useState<{ clipId: string; edge: "in" | "out"; seconds: number } | null>(null);
  const [snapIndicatorSeconds, setSnapIndicatorSeconds] = useState<number | null>(null);

  const playheadDragRef = useRef(false);
  const captionDragRef = useRef<{ clipId: string; mode: DragMode; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);
  const stillsDragRef = useRef<{ clipId: string; mode: DragMode; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);
  const musicDragRef = useRef<{ clipId: string; mode: DragMode; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);
  const overlayDragRef = useRef<{ kind: "text" | "logo"; clipId: string; mode: DragMode; originalStart: number; originalEnd: number; pointerStartSeconds: number } | null>(null);

  function timeAtPointer(event: { clientX: number }): number {
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    return rect ? pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond) : 0;
  }

  function beginPlayheadDrag(event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    if (isPlayingRef.current) pausePreview();
    playheadDragRef.current = true;
  }

  function beginCaptionDrag(clip: TimelineCaptionClipRecord, mode: DragMode, event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const pointerStartSeconds = timeAtPointer(event);
    captionDragRef.current = { clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setCaptionDragPreview({ clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  function beginStillsDrag(clip: TimelineClipRecord, mode: DragMode, event: ReactPointerEvent) {
    // Locked sequences (the default) keep stills synced to narration order —
    // only resizing (mode "start"/"end") is allowed, never repositioning the
    // whole clip. Unlock via the titlebar ⋯ menu to drag-reorder freely.
    if (mode === "move" && timeline?.sequenceLocked) return;
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const pointerStartSeconds = timeAtPointer(event);
    stillsDragRef.current = { clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setStillsDragPreview({ clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  function beginMusicDrag(clip: TimelineMusicClipRecord, mode: DragMode, event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const pointerStartSeconds = timeAtPointer(event);
    musicDragRef.current = { clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setMusicDragPreview({ clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  function beginOverlayDrag(kind: "text" | "logo", clip: OverlayClipRef, mode: DragMode, event: ReactPointerEvent) {
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const pointerStartSeconds = timeAtPointer(event);
    overlayDragRef.current = { kind, clipId: clip.id, mode, originalStart: clip.startSeconds, originalEnd: clip.endSeconds, pointerStartSeconds };
    setOverlayDragPreview({ kind, clipId: clip.id, start: clip.startSeconds, end: clip.endSeconds });
  }

  // Self-contained pointer-capture drag for the fade-handle triangles — kept
  // independent of the shared onDragPointerMove/endDrag dispatcher (which
  // already juggles caption/stills/music/overlay move-and-resize) since this
  // only ever adjusts one clip's fade duration and doesn't need snapping.
  function beginFadeHandleDrag(clip: TimelineMusicClipRecord, edge: "in" | "out", event: ReactPointerEvent) {
    event.stopPropagation();
    event.preventDefault();
    const startClientX = event.clientX;
    const originalSeconds = edge === "in" ? clip.fadeInSeconds : clip.fadeOutSeconds;
    const clipDuration = clip.endSeconds - clip.startSeconds;

    function onMove(moveEvent: PointerEvent) {
      const deltaPx = edge === "in" ? moveEvent.clientX - startClientX : startClientX - moveEvent.clientX;
      const nextSeconds = Math.max(0, Math.min(clipDuration, originalSeconds + deltaPx / pixelsPerSecond));
      setFadeDragPreview({ clipId: clip.id, edge, seconds: nextSeconds });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setFadeDragPreview((current) => {
        if (current && current.clipId === clip.id && activeVideoId) {
          void refresh(projectsClient.setMusicClipSettings(
            activeVideoId, clip.id, clip.volumePercent,
            edge === "in" ? true : clip.fadeInEnabled,
            edge === "in" ? current.seconds : clip.fadeInSeconds,
            edge === "out" ? true : clip.fadeOutEnabled,
            edge === "out" ? current.seconds : clip.fadeOutSeconds,
            clip.autoDuck, clip.loopEnabled,
          ));
        }
        return null;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onDragPointerMove(event: ReactPointerEvent) {
    const rect = canvasInnerRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (playheadDragRef.current) {
      seekPreview(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
      return;
    }
    const time = pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond);
    const snapEnabled = !event.shiftKey;
    let snappedAt: number | null = null;
    const captionDrag = captionDragRef.current;
    if (captionDrag) {
      const targets = [previewTimeRef.current, narrationStart, narrationEnd, ...captionClips.filter((c) => c.id !== captionDrag.clipId).flatMap((c) => [c.startSeconds, c.endSeconds])];
      setCaptionDragPreview((current) => {
        if (!current || current.clipId !== captionDrag.clipId) return current;
        const bounds = nextDragBounds(captionDrag.mode, captionDrag.originalStart, captionDrag.originalEnd, captionDrag.pointerStartSeconds, time, pixelsPerSecond, targets, snapEnabled);
        snappedAt = bounds.snappedAt;
        return { clipId: current.clipId, start: bounds.start, end: bounds.end };
      });
    }
    const stillsDrag = stillsDragRef.current;
    if (stillsDrag) {
      const targets = [previewTimeRef.current, narrationStart, narrationEnd, ...stillsClips.filter((c) => c.id !== stillsDrag.clipId).flatMap((c) => [c.startSeconds, c.endSeconds])];
      setStillsDragPreview((current) => {
        if (!current || current.clipId !== stillsDrag.clipId) return current;
        const bounds = nextDragBounds(stillsDrag.mode, stillsDrag.originalStart, stillsDrag.originalEnd, stillsDrag.pointerStartSeconds, time, pixelsPerSecond, targets, snapEnabled);
        snappedAt = bounds.snappedAt;
        return { clipId: current.clipId, start: bounds.start, end: bounds.end };
      });
    }
    const musicDrag = musicDragRef.current;
    if (musicDrag) {
      const targets = [previewTimeRef.current, ...musicClips.filter((c) => c.id !== musicDrag.clipId).flatMap((c) => [c.startSeconds, c.endSeconds])];
      setMusicDragPreview((current) => {
        if (!current || current.clipId !== musicDrag.clipId) return current;
        const bounds = nextDragBounds(musicDrag.mode, musicDrag.originalStart, musicDrag.originalEnd, musicDrag.pointerStartSeconds, time, pixelsPerSecond, targets, snapEnabled);
        snappedAt = bounds.snappedAt;
        return { clipId: current.clipId, start: bounds.start, end: bounds.end };
      });
    }
    const overlayDrag = overlayDragRef.current;
    if (overlayDrag) {
      const others = [...textClips, ...logoClips].filter((c) => c.id !== overlayDrag.clipId);
      const targets = [previewTimeRef.current, ...others.flatMap((c) => [c.startSeconds, c.endSeconds])];
      setOverlayDragPreview((current) => {
        if (!current || current.clipId !== overlayDrag.clipId) return current;
        const bounds = nextDragBounds(overlayDrag.mode, overlayDrag.originalStart, overlayDrag.originalEnd, overlayDrag.pointerStartSeconds, time, pixelsPerSecond, targets, snapEnabled);
        snappedAt = bounds.snappedAt;
        return { kind: overlayDrag.kind, clipId: current.clipId, start: bounds.start, end: bounds.end };
      });
    }
    if (captionDrag || stillsDrag || musicDrag || overlayDrag) setSnapIndicatorSeconds(snappedAt);
  }

  function endDrag() {
    playheadDragRef.current = false;
    setSnapIndicatorSeconds(null);
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
    const musicDrag = musicDragRef.current;
    if (musicDrag) {
      musicDragRef.current = null;
      setMusicDragPreview((preview) => {
        if (activeVideoId && preview && preview.clipId === musicDrag.clipId
          && (preview.start !== musicDrag.originalStart || preview.end !== musicDrag.originalEnd)) {
          void refresh(projectsClient.updateMusicClip(activeVideoId, musicDrag.clipId, preview.start, preview.end));
        }
        return null;
      });
    }
    const overlayDrag = overlayDragRef.current;
    if (overlayDrag) {
      overlayDragRef.current = null;
      setOverlayDragPreview((preview) => {
        if (activeVideoId && preview && preview.clipId === overlayDrag.clipId
          && (preview.start !== overlayDrag.originalStart || preview.end !== overlayDrag.originalEnd)) {
          const update = overlayDrag.kind === "text"
            ? projectsClient.updateTextOverlayClip(activeVideoId, overlayDrag.clipId, preview.start, preview.end)
            : projectsClient.updateLogoClip(activeVideoId, overlayDrag.clipId, preview.start, preview.end);
          void refresh(update);
        }
        return null;
      });
    }
  }

  return {
    captionDragPreview,
    stillsDragPreview,
    musicDragPreview,
    overlayDragPreview,
    fadeDragPreview,
    snapIndicatorSeconds,
    beginPlayheadDrag,
    beginCaptionDrag,
    beginStillsDrag,
    beginMusicDrag,
    beginOverlayDrag,
    beginFadeHandleDrag,
    onDragPointerMove,
    endDrag,
  };
}

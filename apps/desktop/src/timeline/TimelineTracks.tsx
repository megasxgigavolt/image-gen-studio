import { Clapperboard, Move, Sparkles } from "lucide-react";
import { memo, useEffect, type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent } from "react";
import { formatTime, secondsToPixels, pixelsToSeconds } from "../domain/timecode";
import type { TimelineCaptionClipRecord, TimelineClipRecord } from "../infrastructure/projects-client";
import { motionLabel } from "./timeline-rendering";
import type { ContextMenuItem } from "./ContextMenu";

const NARRATION_LANE_HEIGHT = 28;
const STILLS_LANE_HEIGHT = 72;
const CAPTIONS_LANE_HEIGHT = 28;

type DragPreview = { clipId: string; start: number; end: number } | null;

type TimelineLanesProps = {
  pixelsPerSecond: number;
  audioDataUrl: string | null;
  waveformCanvasRef: RefObject<HTMLCanvasElement | null>;
  onNarrationDuration: (seconds: number) => void;
  narrationOffsetSeconds: number;
  selectedTrack: "narration" | null;
  onSelectNarrationTrack: () => void;
  stillsClips: TimelineClipRecord[];
  stillsDragPreview: DragPreview;
  renderUrls: Record<string, string>;
  /** Thumbnails for clipKind 'imported-still' clips (no renderId of their own). */
  mediaAssetUrls: Record<string, string>;
  selectedClipId: string | null;
  sequenceLocked: boolean;
  onBeginStillsDrag: (clip: TimelineClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSelectStillsClip: (clip: TimelineClipRecord, atSeconds: number) => void;
  onDuplicateStillsClip: (clip: TimelineClipRecord) => void;
  onRemoveStillsClip: (clip: TimelineClipRecord) => void;
  onGoToStillInVisuals: (groupId: string) => void;
  captionClips: TimelineCaptionClipRecord[];
  captionDragPreview: DragPreview;
  selectedCaptionClipId: string | null;
  onBeginCaptionDrag: (clip: TimelineCaptionClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSeek: (time: number) => void;
  onSelectCaptionAndSeek: (clip: TimelineCaptionClipRecord) => void;
  onOpenCaptionsTool: () => void;
  onOpenContextMenu: (event: React.MouseEvent, items: ContextMenuItem[]) => void;
  onSplitCaptionAtPlayhead: (clip: TimelineCaptionClipRecord) => void;
  onMergeCaptionWithNext: (clip: TimelineCaptionClipRecord) => void;
  onDeleteCaptionClip: (clip: TimelineCaptionClipRecord) => void;
  onEditCaptionClip: (clip: TimelineCaptionClipRecord) => void;
  onDropOnTrack: (track: "stills" | "music", event: React.DragEvent, dropSeconds: number) => void;
};

export function TimelineTracks({
  pixelsPerSecond,
  totalWidthPx,
  playheadPx,
  previewTime,
  onBeginPlayheadDrag,
  snapIndicatorSeconds,
  stillsDragPreview,
  captionDragPreview,
  onDeselectTrack,
  onSeek,
  onDragPointerMove,
  onEndDrag,
  onCanvasWheel,
  canvasScrollRef,
  canvasInnerRef,
  ...laneProps
}: TimelineLanesProps & {
  totalWidthPx: number;
  playheadPx: number;
  previewTime: number;
  onBeginPlayheadDrag: (event: ReactPointerEvent) => void;
  snapIndicatorSeconds: number | null;
  onDeselectTrack: () => void;
  onDragPointerMove: (event: ReactPointerEvent) => void;
  onEndDrag: () => void;
  onCanvasWheel: (event: WheelEvent<HTMLDivElement>) => void;
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  canvasInnerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="tl-canvas">
      <div className="tl-lane-gutter">
        <div className="tl-gutter-cell" style={{ height: NARRATION_LANE_HEIGHT }}>Audio</div>
        <div className="tl-gutter-cell" style={{ height: STILLS_LANE_HEIGHT }}>Stills</div>
        <div className="tl-gutter-cell" style={{ height: CAPTIONS_LANE_HEIGHT }}>Captions</div>
      </div>
      <div ref={canvasScrollRef} className="tl-canvas-scroll" onPointerMove={onDragPointerMove} onPointerUp={onEndDrag} onWheel={onCanvasWheel}>
        <div
          ref={canvasInnerRef}
          className="tl-canvas-inner"
          style={{ width: totalWidthPx }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onDeselectTrack();
            onSeek(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
          }}
        >
          <div className="tl-playhead" style={{ left: playheadPx }}>
            <div className="tl-playhead-handle" onPointerDown={onBeginPlayheadDrag} />
            <span className="tl-playhead-tag" onPointerDown={onBeginPlayheadDrag}>{formatTime(previewTime)}</span>
          </div>
          {snapIndicatorSeconds !== null && (
            <div className="tl-snap-indicator" style={{ left: secondsToPixels(snapIndicatorSeconds, pixelsPerSecond) }} />
          )}
          {(() => {
            // Live start/end/duration readout while dragging a stills or
            // caption clip — the two lanes where fine-grained timing matters
            // most. Positioned just above the lane the drag is happening in.
            const active = stillsDragPreview
              ? { preview: stillsDragPreview, top: NARRATION_LANE_HEIGHT }
              : captionDragPreview
                ? { preview: captionDragPreview, top: NARRATION_LANE_HEIGHT + STILLS_LANE_HEIGHT }
                : null;
            if (!active) return null;
            const { preview, top } = active;
            const duration = preview.end - preview.start;
            return (
              <div className="tl-drag-readout" style={{ left: secondsToPixels(preview.start, pixelsPerSecond), top: top - 20 }}>
                {formatTime(preview.start)} – {formatTime(preview.end)} <i>({duration.toFixed(2)}s)</i>
              </div>
            );
          })()}
          <TimelineLanes {...laneProps} pixelsPerSecond={pixelsPerSecond} stillsDragPreview={stillsDragPreview} captionDragPreview={captionDragPreview} onSeek={onSeek} />
        </div>
      </div>
    </div>
  );
}

/** The five actual track lanes (narration/music/stills/overlays/captions) —
 * split out and memoized so that a playing preview's ~15/sec previewTime
 * ticks (see useTimelinePlayback's REACT_SYNC_INTERVAL_MS) only re-render
 * the tiny playhead line above, not this whole subtree. On a caption-heavy
 * project (a still-image "story" video can easily carry 100+ caption
 * clips), re-diffing every clip and caption element on every tick was
 * enough to pin the render thread at 100% and make the whole window stop
 * responding — see the "Editor gets stuck while playing" bug. The custom
 * comparator ignores prop identity for functions only: every value a
 * handler could plausibly close over (selection, drag state, lock state,
 * etc.) is itself a plain prop here and so still triggers a real re-render
 * — it's only the wrapper closures TimelineView recreates every render
 * that would otherwise defeat memoization for no visual benefit. */
const TimelineLanes = memo(function TimelineLanes({
  pixelsPerSecond,
  audioDataUrl,
  waveformCanvasRef,
  onNarrationDuration,
  narrationOffsetSeconds,
  selectedTrack,
  onSelectNarrationTrack,
  stillsClips,
  stillsDragPreview,
  renderUrls,
  mediaAssetUrls,
  selectedClipId,
  sequenceLocked,
  onBeginStillsDrag,
  onSelectStillsClip,
  onDuplicateStillsClip,
  onRemoveStillsClip,
  onGoToStillInVisuals,
  captionClips,
  captionDragPreview,
  selectedCaptionClipId,
  onBeginCaptionDrag,
  onSeek,
  onSelectCaptionAndSeek,
  onOpenCaptionsTool,
  onOpenContextMenu,
  onSplitCaptionAtPlayhead,
  onMergeCaptionWithNext,
  onDeleteCaptionClip,
  onEditCaptionClip,
  onDropOnTrack,
}: TimelineLanesProps) {
  return (
    <>
          <div
            className={selectedTrack === "narration" ? "tl-lane-track tl-narration-track active" : "tl-lane-track tl-narration-track"}
            style={{ height: NARRATION_LANE_HEIGHT }}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onSeek(pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
              onSelectNarrationTrack();
            }}
          >
            {audioDataUrl && (
              <div
                className="tl-narration-offset"
                style={{ left: secondsToPixels(narrationOffsetSeconds, pixelsPerSecond) }}
              >
                <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={onNarrationDuration} />
              </div>
            )}
            {!audioDataUrl && <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={onNarrationDuration} />}
          </div>
          <div
            className="tl-lane-track"
            style={{ height: STILLS_LANE_HEIGHT }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onDropOnTrack("stills", event, pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
            }}
          >
            {!stillsClips.length && <div className="tl-lane-empty-hint">No images generated yet</div>}
            {stillsClips.map((clip) => {
              const isDragging = stillsDragPreview?.clipId === clip.id;
              const start = isDragging ? stillsDragPreview.start : clip.startSeconds;
              const end = isDragging ? stillsDragPreview.end : clip.endSeconds;
              return (
                <div
                  key={clip.id}
                  className={[
                    "tl-clip", "tl-clip-stills",
                    selectedClipId === clip.id ? "active" : "",
                    sequenceLocked ? "locked" : "",
                  ].filter(Boolean).join(" ")}
                  style={{ left: secondsToPixels(start, pixelsPerSecond), width: Math.max(4, secondsToPixels(end - start, pixelsPerSecond)) }}
                  title={sequenceLocked ? "Sequence locked — resize freely, unlock to reorder (⋯ menu)" : undefined}
                  onPointerDown={(event) => onBeginStillsDrag(clip, "move", event)}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onSelectStillsClip(clip, clip.startSeconds + pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
                  }}
                  onContextMenu={(event) => onOpenContextMenu(event, [
                    { label: "Duplicate clip", onSelect: () => onDuplicateStillsClip(clip) },
                    { label: "Remove clip", danger: true, onSelect: () => onRemoveStillsClip(clip) },
                    { label: "Go to this still in Visuals", onSelect: () => onGoToStillInVisuals(clip.groupId) },
                  ])}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginStillsDrag(clip, "start", event)} />
                  {(() => {
                    const thumbnailUrl = (clip.renderId && renderUrls[clip.renderId])
                      || (clip.mediaLibraryAssetId && clip.clipKind === "imported-still" && mediaAssetUrls[clip.mediaLibraryAssetId])
                      || null;
                    // imported-clip has no still poster frame to show here (it's a
                    // video file, not an image) — falls back to its label like any
                    // other clip whose thumbnail hasn't resolved yet.
                    return thumbnailUrl ? <img src={thumbnailUrl} alt="" draggable={false} /> : <span className="tl-clip-fallback">{clip.label}</span>;
                  })()}
                  {clip.transitionIn === "fade" && <span className="tl-clip-badge tl-clip-badge-fade" title="Fade in"><Sparkles size={10} /></span>}
                  {clip.motionPreset !== "none" && <span className="tl-clip-badge tl-clip-badge-motion" title={`Camera: ${motionLabel(clip.motionPreset)}`}><Move size={10} /></span>}
                  {clip.clipKind === "animation" && <span className="tl-clip-badge tl-clip-badge-animation" title="Animated with Veo"><Clapperboard size={10} /></span>}
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginStillsDrag(clip, "end", event)} />
                </div>
              );
            })}
          </div>
          <div className="tl-lane-track tl-captions-track" style={{ height: CAPTIONS_LANE_HEIGHT }} onClick={() => onOpenCaptionsTool()}>
            {!captionClips.length && <div className="tl-lane-empty-hint clickable">No captions generated — click to generate</div>}
            {captionClips.map((clip) => {
              const isDragging = captionDragPreview?.clipId === clip.id;
              const start = isDragging ? captionDragPreview.start : clip.startSeconds;
              const end = isDragging ? captionDragPreview.end : clip.endSeconds;
              const clipWidth = Math.max(3, secondsToPixels(end - start, pixelsPerSecond));
              const isSelected = selectedCaptionClipId === clip.id;
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
                  onPointerDown={(event) => onBeginCaptionDrag(clip, "move", event)}
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    onSeek(clip.startSeconds + pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
                  }}
                  onDoubleClick={(event) => { event.stopPropagation(); onSelectCaptionAndSeek(clip); }}
                  onContextMenu={(event) => onOpenContextMenu(event, [
                    { label: "Edit", onSelect: () => onEditCaptionClip(clip) },
                    { label: "Split at playhead", onSelect: () => onSplitCaptionAtPlayhead(clip) },
                    { label: "Merge with next", onSelect: () => onMergeCaptionWithNext(clip) },
                    { label: "Delete", danger: true, onSelect: () => onDeleteCaptionClip(clip) },
                  ])}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginCaptionDrag(clip, "start", event)} />
                  {clipWidth >= 46 && <span className="tl-clip-text">{clip.text}</span>}
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginCaptionDrag(clip, "end", event)} />
                </div>
              );
            })}
          </div>
    </>
  );
}, arePropsEqualIgnoringFunctionIdentity);

/** Generic React.memo comparator: skips the identity check for any prop
 * that's a function (TimelineView.tsx recreates its ~25 handler closures on
 * every render, which would defeat memo entirely under default shallow
 * comparison), and does a plain Object.is check on everything else. Safe as
 * long as every value a handler could close over is itself passed as a
 * (non-function) prop here too — true today since this component already
 * receives the full slice of relevant state as explicit props rather than
 * reading anything ambient. */
function arePropsEqualIgnoringFunctionIdentity<T extends object>(prev: T, next: T): boolean {
  for (const key of Object.keys(next) as (keyof T)[]) {
    const a = prev[key];
    const b = next[key];
    if (typeof a === "function" && typeof b === "function") continue;
    if (!Object.is(a, b)) return false;
  }
  return true;
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

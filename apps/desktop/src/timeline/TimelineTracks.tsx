import { Clapperboard, Move, Sparkles } from "lucide-react";
import { useEffect, type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent } from "react";
import { formatTime, secondsToPixels, pixelsToSeconds } from "../domain/timecode";
import type {
  TimelineCaptionClipRecord,
  TimelineClipRecord,
  TimelineLogoClipRecord,
  TimelineMusicClipRecord,
  TimelineTextClipRecord,
} from "../infrastructure/projects-client";
import { motionLabel } from "./timeline-rendering";
import type { ContextMenuItem } from "./ContextMenu";

const MUSIC_LANE_HEIGHT = 36;
const OVERLAYS_LANE_HEIGHT = 36;
const NARRATION_LANE_HEIGHT = 28;
const STILLS_LANE_HEIGHT = 72;
const CAPTIONS_LANE_HEIGHT = 28;

type DragPreview = { clipId: string; start: number; end: number } | null;

export function TimelineTracks({
  pixelsPerSecond,
  totalWidthPx,
  playheadPx,
  previewTime,
  audioDataUrl,
  waveformCanvasRef,
  onNarrationDuration,
  narrationOffsetSeconds,
  narrationDragPreview,
  selectedTrack,
  onSelectNarrationTrack,
  onBeginPlayheadDrag,
  onBeginNarrationDrag,
  musicClips,
  musicDragPreview,
  fadeDragPreview,
  selectedMusicClipId,
  onBeginMusicDrag,
  onSelectMusicClip,
  onBeginFadeHandleDrag,
  stillsClips,
  stillsDragPreview,
  renderUrls,
  selectedClipId,
  sequenceLocked,
  onBeginStillsDrag,
  onSelectStillsClip,
  onDuplicateStillsClip,
  onRemoveStillsClip,
  onGoToStillInVisuals,
  logoClips,
  textClips,
  overlayDragPreview,
  activeTool,
  selectedTextClipId,
  onBeginOverlayDrag,
  onSelectLogoTool,
  onSelectTextClip,
  onDoubleClickTextClip,
  captionClips,
  captionDragPreview,
  selectedCaptionClipId,
  snapIndicatorSeconds,
  onBeginCaptionDrag,
  onSeek,
  onSelectCaptionAndSeek,
  onOpenCaptionsTool,
  onOpenContextMenu,
  onSplitCaptionAtPlayhead,
  onMergeCaptionWithNext,
  onDeleteCaptionClip,
  onEditCaptionClip,
  onDeselectTrack,
  onDropOnTrack,
  onDragPointerMove,
  onEndDrag,
  onCanvasWheel,
  canvasScrollRef,
  canvasInnerRef,
}: {
  pixelsPerSecond: number;
  totalWidthPx: number;
  playheadPx: number;
  previewTime: number;
  audioDataUrl: string | null;
  waveformCanvasRef: RefObject<HTMLCanvasElement | null>;
  onNarrationDuration: (seconds: number) => void;
  narrationOffsetSeconds: number;
  narrationDragPreview: number | null;
  selectedTrack: "narration" | null;
  onSelectNarrationTrack: () => void;
  onBeginPlayheadDrag: (event: ReactPointerEvent) => void;
  onBeginNarrationDrag: (event: ReactPointerEvent) => void;
  musicClips: TimelineMusicClipRecord[];
  musicDragPreview: DragPreview;
  fadeDragPreview: { clipId: string; edge: "in" | "out"; seconds: number } | null;
  selectedMusicClipId: string | null;
  onBeginMusicDrag: (clip: TimelineMusicClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSelectMusicClip: (clip: TimelineMusicClipRecord) => void;
  onBeginFadeHandleDrag: (clip: TimelineMusicClipRecord, edge: "in" | "out", event: ReactPointerEvent) => void;
  stillsClips: TimelineClipRecord[];
  stillsDragPreview: DragPreview;
  renderUrls: Record<string, string>;
  selectedClipId: string | null;
  sequenceLocked: boolean;
  onBeginStillsDrag: (clip: TimelineClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSelectStillsClip: (clip: TimelineClipRecord) => void;
  onDuplicateStillsClip: (clip: TimelineClipRecord) => void;
  onRemoveStillsClip: (clip: TimelineClipRecord) => void;
  onGoToStillInVisuals: (groupId: string) => void;
  logoClips: TimelineLogoClipRecord[];
  textClips: TimelineTextClipRecord[];
  overlayDragPreview: { kind: "text" | "logo"; clipId: string; start: number; end: number } | null;
  activeTool: string | null;
  selectedTextClipId: string | null;
  onBeginOverlayDrag: (kind: "text" | "logo", clip: { id: string; startSeconds: number; endSeconds: number }, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSelectLogoTool: () => void;
  onSelectTextClip: (clip: TimelineTextClipRecord) => void;
  onDoubleClickTextClip: (clip: TimelineTextClipRecord) => void;
  captionClips: TimelineCaptionClipRecord[];
  captionDragPreview: DragPreview;
  selectedCaptionClipId: string | null;
  snapIndicatorSeconds: number | null;
  onBeginCaptionDrag: (clip: TimelineCaptionClipRecord, mode: "start" | "end" | "move", event: ReactPointerEvent) => void;
  onSeek: (time: number) => void;
  onSelectCaptionAndSeek: (clip: TimelineCaptionClipRecord) => void;
  onOpenCaptionsTool: () => void;
  onOpenContextMenu: (event: React.MouseEvent, items: ContextMenuItem[]) => void;
  onSplitCaptionAtPlayhead: (clip: TimelineCaptionClipRecord) => void;
  onMergeCaptionWithNext: (clip: TimelineCaptionClipRecord) => void;
  onDeleteCaptionClip: (clip: TimelineCaptionClipRecord) => void;
  onEditCaptionClip: (clip: TimelineCaptionClipRecord) => void;
  onDeselectTrack: () => void;
  onDropOnTrack: (track: "stills" | "music", event: React.DragEvent, dropSeconds: number) => void;
  onDragPointerMove: (event: ReactPointerEvent) => void;
  onEndDrag: () => void;
  onCanvasWheel: (event: WheelEvent<HTMLDivElement>) => void;
  canvasScrollRef: RefObject<HTMLDivElement | null>;
  canvasInnerRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="tl-canvas">
      <div className="tl-lane-gutter">
        <div className="tl-gutter-cell" style={{ height: NARRATION_LANE_HEIGHT }}>Narration</div>
        <div className="tl-gutter-cell" style={{ height: MUSIC_LANE_HEIGHT }}>Music</div>
        <div className="tl-gutter-cell" style={{ height: STILLS_LANE_HEIGHT }}>Stills</div>
        <div className="tl-gutter-cell" style={{ height: OVERLAYS_LANE_HEIGHT }}>Overlays</div>
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
              ? { preview: stillsDragPreview, top: NARRATION_LANE_HEIGHT + MUSIC_LANE_HEIGHT }
              : captionDragPreview
                ? { preview: captionDragPreview, top: NARRATION_LANE_HEIGHT + MUSIC_LANE_HEIGHT + STILLS_LANE_HEIGHT + OVERLAYS_LANE_HEIGHT }
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
          <div
            className={selectedTrack === "narration" ? "tl-lane-track tl-narration-track active" : "tl-lane-track tl-narration-track"}
            style={{ height: NARRATION_LANE_HEIGHT }}
            onClick={(event) => { event.stopPropagation(); onSelectNarrationTrack(); }}
          >
            {audioDataUrl && (
              <div
                className="tl-narration-offset"
                style={{ left: secondsToPixels(narrationDragPreview ?? narrationOffsetSeconds, pixelsPerSecond) }}
                onPointerDown={onBeginNarrationDrag}
                title="Drag to shift when narration starts"
              >
                <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={onNarrationDuration} />
              </div>
            )}
            {!audioDataUrl && <NarrationWaveform audioDataUrl={audioDataUrl} pixelsPerSecond={pixelsPerSecond} canvasRef={waveformCanvasRef} onDuration={onNarrationDuration} />}
          </div>
          <div
            className="tl-lane-track tl-music-track"
            style={{ height: MUSIC_LANE_HEIGHT }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onDropOnTrack("music", event, pixelsToSeconds(event.clientX - rect.left, pixelsPerSecond));
            }}
          >
            {!musicClips.length && <div className="tl-lane-empty-hint dashed">Drop audio here or use the Music tool</div>}
            {musicClips.map((clip) => {
              const isDragging = musicDragPreview?.clipId === clip.id;
              const start = isDragging ? musicDragPreview.start : clip.startSeconds;
              const end = isDragging ? musicDragPreview.end : clip.endSeconds;
              const fadeInSeconds = fadeDragPreview?.clipId === clip.id && fadeDragPreview.edge === "in" ? fadeDragPreview.seconds : clip.fadeInSeconds;
              const fadeOutSeconds = fadeDragPreview?.clipId === clip.id && fadeDragPreview.edge === "out" ? fadeDragPreview.seconds : clip.fadeOutSeconds;
              return (
                <div
                  key={clip.id}
                  className={selectedMusicClipId === clip.id ? "tl-clip tl-clip-music active" : "tl-clip tl-clip-music"}
                  style={{ left: secondsToPixels(start, pixelsPerSecond), width: Math.max(4, secondsToPixels(end - start, pixelsPerSecond)) }}
                  title={clip.label}
                  onPointerDown={(event) => onBeginMusicDrag(clip, "move", event)}
                  onClick={(event) => { event.stopPropagation(); onSelectMusicClip(clip); }}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginMusicDrag(clip, "start", event)} />
                  <span className="tl-clip-text">{clip.label}</span>
                  {clip.autoDuck && <span className="tl-clip-badge tl-clip-badge-motion" title="Auto-duck enabled"><Sparkles size={10} /></span>}
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginMusicDrag(clip, "end", event)} />
                  <div
                    className={clip.fadeInEnabled ? "tl-fade-handle in enabled" : "tl-fade-handle in"}
                    style={{ left: secondsToPixels(fadeInSeconds, pixelsPerSecond) }}
                    title={`Fade in: ${fadeInSeconds.toFixed(1)}s`}
                    onPointerDown={(event) => onBeginFadeHandleDrag(clip, "in", event)}
                  />
                  <div
                    className={clip.fadeOutEnabled ? "tl-fade-handle out enabled" : "tl-fade-handle out"}
                    style={{ right: secondsToPixels(fadeOutSeconds, pixelsPerSecond) }}
                    title={`Fade out: ${fadeOutSeconds.toFixed(1)}s`}
                    onPointerDown={(event) => onBeginFadeHandleDrag(clip, "out", event)}
                  />
                </div>
              );
            })}
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
                  onClick={(event) => { event.stopPropagation(); onSelectStillsClip(clip); }}
                  onContextMenu={(event) => onOpenContextMenu(event, [
                    { label: "Duplicate clip", onSelect: () => onDuplicateStillsClip(clip) },
                    { label: "Remove clip", danger: true, onSelect: () => onRemoveStillsClip(clip) },
                    { label: "Go to this still in Visuals", onSelect: () => onGoToStillInVisuals(clip.groupId) },
                  ])}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginStillsDrag(clip, "start", event)} />
                  {clip.renderId && renderUrls[clip.renderId] ? <img src={renderUrls[clip.renderId]} alt="" draggable={false} /> : <span className="tl-clip-fallback">{clip.label}</span>}
                  {clip.transitionIn === "fade" && <span className="tl-clip-badge tl-clip-badge-fade" title="Fade in"><Sparkles size={10} /></span>}
                  {clip.motionPreset !== "none" && <span className="tl-clip-badge tl-clip-badge-motion" title={`Camera: ${motionLabel(clip.motionPreset)}`}><Move size={10} /></span>}
                  {clip.clipKind === "animation" && <span className="tl-clip-badge tl-clip-badge-animation" title="Animated with Veo"><Clapperboard size={10} /></span>}
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginStillsDrag(clip, "end", event)} />
                </div>
              );
            })}
          </div>
          <div className="tl-lane-track" style={{ height: OVERLAYS_LANE_HEIGHT }}>
            {logoClips.map((clip) => {
              const isDragging = overlayDragPreview?.kind === "logo" && overlayDragPreview.clipId === clip.id;
              const start = isDragging ? overlayDragPreview.start : clip.startSeconds;
              const end = isDragging ? overlayDragPreview.end : clip.endSeconds;
              return (
                <div
                  key={clip.id}
                  className={activeTool === "logo" ? "tl-clip tl-clip-overlay tl-clip-logo active" : "tl-clip tl-clip-overlay tl-clip-logo"}
                  style={{ left: secondsToPixels(start, pixelsPerSecond), width: Math.max(4, secondsToPixels(end - start, pixelsPerSecond)) }}
                  title="Logo / watermark"
                  onPointerDown={(event) => onBeginOverlayDrag("logo", clip, "move", event)}
                  onClick={(event) => { event.stopPropagation(); onSelectLogoTool(); }}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginOverlayDrag("logo", clip, "start", event)} />
                  <span className="tl-clip-text">Logo</span>
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginOverlayDrag("logo", clip, "end", event)} />
                </div>
              );
            })}
            {textClips.map((clip) => {
              const isDragging = overlayDragPreview?.kind === "text" && overlayDragPreview.clipId === clip.id;
              const start = isDragging ? overlayDragPreview.start : clip.startSeconds;
              const end = isDragging ? overlayDragPreview.end : clip.endSeconds;
              return (
                <div
                  key={clip.id}
                  className={selectedTextClipId === clip.id ? "tl-clip tl-clip-overlay tl-clip-text active" : "tl-clip tl-clip-overlay tl-clip-text"}
                  style={{ left: secondsToPixels(start, pixelsPerSecond), width: Math.max(4, secondsToPixels(end - start, pixelsPerSecond)) }}
                  title={clip.text}
                  onPointerDown={(event) => onBeginOverlayDrag("text", clip, "move", event)}
                  onClick={(event) => { event.stopPropagation(); onSelectTextClip(clip); }}
                  onDoubleClick={(event) => { event.stopPropagation(); onDoubleClickTextClip(clip); }}
                >
                  <div className="tl-clip-resize-handle left" onPointerDown={(event) => onBeginOverlayDrag("text", clip, "start", event)} />
                  <span className="tl-clip-text">{clip.text || "Text"}</span>
                  <div className="tl-clip-resize-handle right" onPointerDown={(event) => onBeginOverlayDrag("text", clip, "end", event)} />
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
                  onClick={(event) => { event.stopPropagation(); onSeek(clip.startSeconds); }}
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
        </div>
      </div>
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

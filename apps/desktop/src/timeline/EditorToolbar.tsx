import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  ScanSearch,
  Type,
  Undo2,
} from "lucide-react";
import { formatTime } from "../domain/timecode";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export { ZOOM_MIN, ZOOM_MAX };

/** The bottom bar above the timeline tracks: undo/redo, playhead navigation
 * (step/jump-to-clip), the running time readout, play/pause, zoom (incl.
 * zoom-to-selection), and a captions status badge. Distinct from
 * `Toolbar.tsx` (the left tool-select strip for Text/Captions/Music/
 * Filters/Logo) — this one is about navigating and scrubbing the timeline
 * itself. */
export function EditorToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  previewTime,
  totalDuration,
  isPlaying,
  onTogglePlay,
  hasStillsClips,
  zoom,
  onFit,
  onZoomChange,
  onZoomToSelection,
  canZoomToSelection,
  onJumpPreviousClip,
  onJumpNextClip,
  onStepBackward,
  onStepForward,
  captionCount,
  onOpenCaptionsTool,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  previewTime: number;
  totalDuration: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  hasStillsClips: boolean;
  zoom: number;
  onFit: () => void;
  onZoomChange: (zoom: number) => void;
  onZoomToSelection: () => void;
  canZoomToSelection: boolean;
  onJumpPreviousClip: () => void;
  onJumpNextClip: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  captionCount: number;
  onOpenCaptionsTool: () => void;
}) {
  return (
    <div className="tl-toolbar">
      <div className="tl-toolbar-group tl-toolbar-left">
        <div className="tl-history-controls">
          <button className="tl-icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} /></button>
          <button className="tl-icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}><Redo2 size={15} /></button>
        </div>
      </div>
      <div className="tl-toolbar-group tl-toolbar-center">
        <div className="tl-transport-controls">
          <button className="tl-icon-btn" title="Previous clip (Shift+←)" disabled={!hasStillsClips} onClick={onJumpPreviousClip}><ChevronFirst size={14} /></button>
          <button className="tl-icon-btn" title="Step back one frame (←)" onClick={onStepBackward}><ChevronLeft size={14} /></button>
          <button
            className="tl-play-btn"
            onClick={onTogglePlay}
            disabled={!hasStillsClips}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button className="tl-icon-btn" title="Step forward one frame (→)" onClick={onStepForward}><ChevronRight size={14} /></button>
          <button className="tl-icon-btn" title="Next clip (Shift+→)" disabled={!hasStillsClips} onClick={onJumpNextClip}><ChevronLast size={14} /></button>
        </div>
        <span className="tl-preview-time">{formatTime(previewTime)} <i>/</i> {formatTime(totalDuration)}</span>
      </div>
      <div className="tl-toolbar-group tl-toolbar-right">
        <button
          className="tl-captions-status-badge"
          title={captionCount ? `${captionCount} caption${captionCount === 1 ? "" : "s"} — click to edit` : "No captions yet — click to generate"}
          onClick={onOpenCaptionsTool}
        >
          <Type size={12} />
          {captionCount ? `${captionCount} caption${captionCount === 1 ? "" : "s"}` : "No captions"}
        </button>
        <div className="tl-zoom-control">
          <button className="tl-icon-btn" title="Fit to window" onClick={onFit}><Maximize2 size={13} /></button>
          <button className="tl-icon-btn" title="Zoom to selected clip" disabled={!canZoomToSelection} onClick={onZoomToSelection}><ScanSearch size={13} /></button>
          <button className="tl-icon-btn" title="Zoom out" onClick={() => onZoomChange(zoom - 0.25)}><Minus size={13} /></button>
          <input type="range" className="tl-slider" min={ZOOM_MIN} max={ZOOM_MAX} step=".25" value={zoom} onChange={(event) => onZoomChange(Number(event.target.value))} />
          <button className="tl-icon-btn" title="Zoom in" onClick={() => onZoomChange(zoom + 0.25)}><Plus size={13} /></button>
          <span className="tl-zoom-label">{Math.round(zoom * 100)}%</span>
        </div>
      </div>
    </div>
  );
}

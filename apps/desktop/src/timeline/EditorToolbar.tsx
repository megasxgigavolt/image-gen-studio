import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Redo2,
  Undo2,
} from "lucide-react";
import { formatTime } from "../domain/timecode";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;

export { ZOOM_MIN, ZOOM_MAX };

/** Zone A — the playback cluster directly below the preview: undo/redo,
 * playhead navigation (step/jump-to-clip), play/pause, and the running time
 * readout. Deliberately compact and centered (not a full-width bar) so it
 * reads as attached to the preview above it, like a media player's transport
 * bar, rather than another toolbar row. */
export function PlaybackControls({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  previewTime,
  totalDuration,
  isPlaying,
  onTogglePlay,
  hasStillsClips,
  onJumpPreviousClip,
  onJumpNextClip,
  onStepBackward,
  onStepForward,
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
  onJumpPreviousClip: () => void;
  onJumpNextClip: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
}) {
  return (
    <div className="tl-playback-row">
      <div className="tl-playback-cluster">
        <div className="tl-history-controls">
          <button className="tl-icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}><Undo2 size={15} /></button>
          <button className="tl-icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}><Redo2 size={15} /></button>
        </div>
        <div className="tl-playback-divider" aria-hidden="true" />
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
    </div>
  );
}

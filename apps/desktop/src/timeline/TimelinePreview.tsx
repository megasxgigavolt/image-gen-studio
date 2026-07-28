import type { RefObject } from "react";

/** The canvas the current frame is drawn onto (see useTimelinePlayback's
 * drawFrame) — this component is deliberately dumb, it owns no state of its
 * own, just the empty-state fallback for before any stills exist. */
export function TimelinePreview({
  hasStillsClips,
  canvasRef,
  canvasSize,
}: {
  hasStillsClips: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasSize: { width: number; height: number };
}) {
  return (
    <div className="tl-preview-pane">
      <div className="tl-preview-frame">
        {hasStillsClips ? (
          <canvas ref={canvasRef} width={canvasSize.width} height={canvasSize.height} />
        ) : (
          <div className="tl-preview-empty">Add stills to the timeline to begin editing.</div>
        )}
      </div>
    </div>
  );
}

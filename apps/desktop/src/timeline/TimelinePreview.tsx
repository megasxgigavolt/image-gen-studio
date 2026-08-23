import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";

// Caps how many pixels fullscreen ever renders at, regardless of the actual
// screen's own resolution — matches the app's own highest export option
// (2160p) as a sane ceiling; there's no point drawing more detail than the
// app itself will ever export, and it keeps a very high-DPI/multi-monitor
// setup from making every frame noticeably more expensive to draw.
const FULLSCREEN_MAX_DIMENSION_PX = 3840;

/** The canvas the current frame is drawn onto (see useTimelinePlayback's
 * drawFrame) — this component owns no playback state of its own, just the
 * empty-state fallback for before any stills exist, and its own fullscreen
 * toggle. Fullscreen promotes the SAME canvas element the editor already
 * continuously redraws (via the browser's native Fullscreen API on this
 * component's own frame div) rather than duplicating any rendering — the
 * point is to see the frame at something close to real viewing size/scale,
 * since the editor's own small preview canvas can visually hide sizing
 * issues (e.g. captions) that only become obvious at real size.
 *
 * The canvas's own backing resolution (its width/height attributes, as
 * opposed to however large CSS stretches it on screen) is bumped up while
 * fullscreen — `useTimelinePlayback`'s drawFrame reads `canvas.width`/
 * `canvas.height` directly on every frame, so just resizing the element is
 * enough to make it redraw sharp at the new resolution with no other code
 * changes. Leaving the backing resolution at the small edit-time size (as
 * an earlier version of this did) while CSS-stretching the element to fill
 * the whole screen just upscaled that same small bitmap — visibly blurry,
 * exactly the same way a low-resolution source image looks soft once
 * blown up to fill a large export frame. */
export function TimelinePreview({
  hasStillsClips,
  canvasRef,
  canvasSize,
  onCanvasResized,
}: {
  hasStillsClips: boolean;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  canvasSize: { width: number; height: number };
  /** Changing a canvas's width/height attributes clears its bitmap back to
   * blank — called right after the DOM actually picks up a new size (both
   * entering and leaving fullscreen) so the caller can force an immediate
   * redraw instead of leaving a blank canvas up until the next frame some
   * other trigger (playback, a seek, an asset finishing load) happens to
   * redraw it anyway. */
  onCanvasResized: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenCanvasSize, setFullscreenCanvasSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === frameRef.current;
      setIsFullscreen(active);
      if (!active) {
        setFullscreenCanvasSize(null);
        return;
      }
      // Render at the real screen's native pixel density (devicePixelRatio),
      // scaled down to fit FULLSCREEN_MAX_DIMENSION_PX, preserving
      // canvasSize's own aspect ratio exactly — the recipe/rect math in
      // drawFrame reads canvas.width/height directly, so it stays correct
      // at any resolution as long as the aspect ratio itself doesn't change.
      const aspect = canvasSize.width / canvasSize.height;
      const dpr = window.devicePixelRatio || 1;
      let width = window.screen.width * dpr;
      let height = width / aspect;
      const screenHeight = window.screen.height * dpr;
      if (height > screenHeight) {
        height = screenHeight;
        width = height * aspect;
      }
      const scaleDown = Math.min(1, FULLSCREEN_MAX_DIMENSION_PX / Math.max(width, height));
      setFullscreenCanvasSize({ width: Math.round(width * scaleDown), height: Math.round(height * scaleDown) });
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [canvasSize]);

  async function toggleFullscreen() {
    if (document.fullscreenElement === frameRef.current) {
      await document.exitFullscreen();
    } else {
      await frameRef.current?.requestFullscreen();
    }
  }

  const activeCanvasSize = fullscreenCanvasSize ?? canvasSize;

  // Runs after the DOM has actually applied the new width/height (which
  // just cleared the canvas back to blank) — see onCanvasResized's own doc
  // comment above for why this can't just wait for the next natural redraw.
  useEffect(() => {
    onCanvasResized();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCanvasSize.width, activeCanvasSize.height]);

  return (
    <div className="tl-preview-pane">
      <div ref={frameRef} className={isFullscreen ? "tl-preview-frame fullscreen" : "tl-preview-frame"}>
        {hasStillsClips ? (
          <>
            <canvas ref={canvasRef} width={activeCanvasSize.width} height={activeCanvasSize.height} />
            <button
              type="button"
              className="tl-preview-fullscreen-btn"
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? "Exit full screen" : "Full screen — see the final video at real size"}
            >
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        ) : (
          <div className="tl-preview-empty">Add stills to the timeline to begin editing.</div>
        )}
      </div>
    </div>
  );
}

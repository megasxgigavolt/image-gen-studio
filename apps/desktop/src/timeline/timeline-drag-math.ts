// Distance (in seconds) within which a dragged edge snaps to a nearby
// target — computed from a fixed pixel threshold so it stays a consistent
// on-screen distance regardless of zoom.
export const SNAP_THRESHOLD_PX = 6;

export type DragMode = "start" | "end" | "move";

/** Snaps `time` onto the nearest of `targets` within a pixel-derived
 * threshold, if any is close enough and snapping is enabled (held Shift
 * while dragging disables it). Returns the original time unchanged
 * otherwise. */
export function snapTime(
  time: number,
  targets: number[],
  enabled: boolean,
  pixelsPerSecond: number,
  thresholdPx: number = SNAP_THRESHOLD_PX,
): { value: number; snapped: boolean } {
  if (!enabled || !targets.length || pixelsPerSecond <= 0) return { value: time, snapped: false };
  const thresholdSeconds = thresholdPx / pixelsPerSecond;
  let best = time;
  let bestDist = thresholdSeconds;
  let snapped = false;
  for (const target of targets) {
    const dist = Math.abs(target - time);
    if (dist < bestDist) { bestDist = dist; best = target; snapped = true; }
  }
  return { value: best, snapped };
}

/** Shared move/resize math for a lane of clips: edge handles clamp to the
 * clip's own opposite edge (a minimum 0.1s length), while a body drag shifts
 * both edges by the same delta so the clip's own duration never changes —
 * only its position on the timeline does. `snapTargets`/`snapEnabled` pull
 * the moving edge onto a nearby clip boundary or the playhead. */
export function nextDragBounds(
  mode: DragMode,
  originalStart: number,
  originalEnd: number,
  pointerStartSeconds: number,
  time: number,
  pixelsPerSecond: number,
  snapTargets: number[] = [],
  snapEnabled = false,
): { start: number; end: number; snappedAt: number | null } {
  if (mode === "start") {
    const { value, snapped } = snapTime(time, snapTargets, snapEnabled, pixelsPerSecond);
    const start = Math.max(0, Math.min(value, originalEnd - 0.1));
    return { start, end: originalEnd, snappedAt: snapped ? start : null };
  }
  if (mode === "end") {
    const { value, snapped } = snapTime(time, snapTargets, snapEnabled, pixelsPerSecond);
    const end = Math.max(originalStart + 0.1, value);
    return { start: originalStart, end, snappedAt: snapped ? end : null };
  }
  const delta = time - pointerStartSeconds;
  const duration = originalEnd - originalStart;
  const rawStart = Math.max(0, originalStart + delta);
  const { value: start, snapped } = snapTime(rawStart, snapTargets, snapEnabled, pixelsPerSecond);
  return { start, end: start + duration, snappedAt: snapped ? start : null };
}

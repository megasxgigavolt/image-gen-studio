const CAPCUT_FRAME_RATE = 30;

function pad(value: number, length = 2) {
  return String(value).padStart(length, "0");
}

export function formatTime(seconds: number) {
  const clampedSeconds = Math.max(0, seconds);
  const totalFrames = Math.round(clampedSeconds * CAPCUT_FRAME_RATE);
  const frames = totalFrames % CAPCUT_FRAME_RATE;
  const totalWholeSeconds = Math.floor(totalFrames / CAPCUT_FRAME_RATE);
  const wholeSeconds = totalWholeSeconds % 60;
  const totalMinutes = Math.floor(totalWholeSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}:${pad(frames)}`;
}

export function secondsToPixels(seconds: number, pixelsPerSecond: number): number {
  return seconds * pixelsPerSecond;
}

export function pixelsToSeconds(pixels: number, pixelsPerSecond: number): number {
  if (pixelsPerSecond <= 0) return 0;
  return pixels / pixelsPerSecond;
}

export type TimeRange = { start: number; end: number };

/**
 * Clamps a proposed clip position against its immediate neighbors on the same
 * track so a live drag/resize never visually overlaps another clip. `clips`
 * should exclude the clip currently being moved/resized. Freeform positioning
 * still forbids same-track overlap — only gaps and reordering are allowed.
 */
export function clampAgainstNeighbors(
  clips: TimeRange[],
  proposedStart: number,
  proposedEnd: number,
): TimeRange {
  const duration = Math.max(0.05, proposedEnd - proposedStart);
  let start = Math.max(0, proposedStart);

  // Nearest clip that starts at or before our start point (may overlap it).
  const previous = clips
    .filter((clip) => clip.start <= start)
    .sort((a, b) => b.end - a.end)[0];
  if (previous && start < previous.end) {
    start = previous.end;
  }

  let end = start + duration;

  // Nearest clip that starts at or after our (possibly-adjusted) start point.
  const next = clips
    .filter((clip) => clip.start >= start)
    .sort((a, b) => a.start - b.start)[0];
  if (next && end > next.start) {
    end = next.start;
    start = Math.max(previous ? previous.end : 0, Math.min(start, end - duration));
  }
  if (end <= start) {
    end = start + 0.05;
  }
  return { start, end };
}

/**
 * Like `clampAgainstNeighbors`, but for pure moves: duration is a fixed,
 * rigid property of the clip and is never compressed to fit a gap — the
 * clip instead stops (rigid-body collision) at the neighbor's edge. Duration
 * changes are only ever the result of an explicit resize-handle drag.
 */
export function clampMoveAgainstNeighbors(
  clips: TimeRange[],
  proposedStart: number,
  duration: number,
): TimeRange {
  let start = Math.max(0, proposedStart);
  const previous = clips
    .filter((clip) => clip.start <= start)
    .sort((a, b) => b.end - a.end)[0];
  if (previous && start < previous.end) {
    start = previous.end;
  }

  let end = start + duration;
  const next = clips
    .filter((clip) => clip.start >= start)
    .sort((a, b) => a.start - b.start)[0];
  if (next && end > next.start) {
    end = next.start;
    start = end - duration;
    // Gap is smaller than the clip's own duration — nowhere to slide without
    // overlap either way, so pin to the previous clip's edge as a last resort.
    if (previous && start < previous.end) start = previous.end;
    end = start + duration;
  }
  return { start, end };
}

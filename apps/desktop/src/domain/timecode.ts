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

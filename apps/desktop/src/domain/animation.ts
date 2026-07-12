// Veo 3 only generates clips at these fixed lengths — never an arbitrary
// duration. This is a predictive-only copy of the Rust `pick_veo_duration`
// (apps/desktop/src-tauri/src/projects.rs) used purely so the "Generate
// Animation" panel can show "will generate as 6.0s" before submitting,
// without a round trip. The Rust copy is the source of truth actually
// enforced at generation time.
export const VEO_ALLOWED_DURATIONS = [4, 6, 8] as const;

/**
 * Picks the largest Veo-supported duration that still fits inside the target
 * gap, so "Adjust animation to duration" only ever needs to slow the clip
 * down (stretch), never speed it up. Falls back to the shortest duration if
 * the gap is under 4s — the excess is trimmed immediately after generation.
 */
export function pickVeoDuration(gapSeconds: number): number {
  const fitting = VEO_ALLOWED_DURATIONS.filter((duration) => duration <= gapSeconds);
  return fitting.length > 0 ? Math.max(...fitting) : VEO_ALLOWED_DURATIONS[0];
}

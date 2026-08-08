import {
  ArrowLeft,
  ArrowRight,
  Ban,
  Layers,
  Move,
  Scissors,
  Shuffle,
  Sparkles,
  Sun,
  Wind,
  Droplets,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { CaptionStyle, MotionPreset, TransitionPreset } from "../infrastructure/projects-client";

// Mirrors the Rust default_caption_style() exactly, so an all-default style
// looks identical to what used to be hardcoded in the export engine.
export const DEFAULT_CAPTION_STYLE: Required<CaptionStyle> = {
  fontFamily: "Rubik",
  fontSizePx: 22,
  bold: true,
  color: "#FFFFFF",
  opacity: 100,
  outlineColor: "#000000",
  outlineWidthPx: 2,
  shadow: { enabled: false, color: "#000000", opacity: 70, blur: 30, distance: 2, angle: 90 },
  position: "bottom",
  wordHighlight: { enabled: false, color: "#FFEB3B" },
};

// "Rubik" is listed first to match the default — it renders correctly if the
// font is installed on the system (or another app/font manager has added
// it), and otherwise falls back silently like any other missing font.
export const CAPTION_FONT_OPTIONS = ["Rubik", "Arial Black", "Arial", "Impact", "Verdana", "Georgia", "Courier New"];

export const CAPTION_STYLE_PRESETS: { label: string; style: Partial<CaptionStyle> }[] = [
  { label: "Clean White", style: { color: "#FFFFFF", outlineColor: "#000000", bold: true, shadow: { enabled: false, color: "#000000", opacity: 70, blur: 30, distance: 2, angle: 90 } } },
  { label: "Bold Yellow", style: { color: "#FFEB3B", outlineColor: "#000000", outlineWidthPx: 3, bold: true, shadow: { enabled: false, color: "#000000", opacity: 70, blur: 30, distance: 2, angle: 90 } } },
  { label: "Impact Red", style: { color: "#FFFFFF", outlineColor: "#D32F2F", outlineWidthPx: 3, bold: true, shadow: { enabled: false, color: "#000000", opacity: 70, blur: 30, distance: 2, angle: 90 } } },
  { label: "Soft Shadow", style: { color: "#FFFFFF", outlineColor: "#000000", outlineWidthPx: 1, bold: false, shadow: { enabled: true, color: "#000000", opacity: 60, blur: 45, distance: 3, angle: 90 } } },
];

// Caption shadow "Blur" is authored as a 0-100% slider; this is the canvas
// shadowBlur radius (px) that 100% maps to.
export const MAX_SHADOW_BLUR_PX = 20;

/** Shallow-merges a partial style onto a base — mirrors the Rust merge_style. */
export function resolveCaptionStyle(base: CaptionStyle, overlay?: CaptionStyle | null): Required<CaptionStyle> {
  return { ...DEFAULT_CAPTION_STYLE, ...base, ...(overlay ?? {}) };
}

/** Converts a #RRGGBB color + 0-100 opacity into a canvas rgba() string. */
export function withAlpha(hex: string, opacityPercent: number): string {
  const clean = (hex || "#000000").replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = Math.max(0, Math.min(100, opacityPercent)) / 100;
  return `rgba(${r},${g},${b},${a})`;
}

export const MOTION_OPTIONS: { value: MotionPreset; label: string; icon: typeof Move }[] = [
  { value: "zoom-in", label: "Zoom in", icon: ZoomIn },
  { value: "zoom-out", label: "Zoom out", icon: ZoomOut },
  { value: "zoom-pulse", label: "Zoom pulse", icon: Shuffle },
  { value: "pan-left", label: "Pan left", icon: ArrowLeft },
  { value: "pan-right", label: "Pan right", icon: ArrowRight },
  { value: "zoom-in-subject", label: "Zoom in on subject", icon: ZoomIn },
  { value: "zoom-out-subject", label: "Zoom out on subject", icon: ZoomOut },
  { value: "ken-burns", label: "Ken Burns", icon: Move },
  { value: "none", label: "None", icon: Ban },
];

// The last 6 are "join" transitions (blend into the next clip) — only ever
// meaningful on the "out" side of a boundary, see VALID_TRANSITIONS's doc
// comment in projects.rs. The "in" picker only renders the first 3.
export const TRANSITION_OPTIONS: { value: TransitionPreset; label: string; icon: typeof Scissors }[] = [
  { value: "cut", label: "Cut", icon: Scissors },
  { value: "fade", label: "Fade", icon: Sparkles },
  { value: "dip-to-white", label: "Dip white", icon: Sun },
  { value: "cross-fade", label: "Cross-fade", icon: Layers },
  { value: "slide-left", label: "Slide left", icon: ArrowLeft },
  { value: "slide-right", label: "Slide right", icon: ArrowRight },
  { value: "zoom-blur", label: "Zoom blur", icon: ZoomIn },
  { value: "whip-pan", label: "Whip pan", icon: Wind },
  { value: "blur-transition", label: "Blur", icon: Droplets },
];
export const TRANSITION_IN_OPTIONS = TRANSITION_OPTIONS.slice(0, 3);

export function motionLabel(preset: MotionPreset): string {
  return MOTION_OPTIONS.find((option) => option.value === preset)?.label ?? "None";
}

// Matches the export engine: `intensity` is the total zoom/pan amount over
// REFERENCE_DURATION seconds, applied as a constant per-second rate to every
// clip so the effect feels equally fast regardless of a still's own duration.
// `MAX_SCALE_REFERENCE_DURATION` only bounds pathological cases (it's well
// beyond any realistic still duration) — it must never be reached in normal
// use, unlike the old `1 + amount*3` cap which froze zoom at exactly 15s.
const MOTION_REFERENCE_DURATION = 5.0;
const MAX_SCALE_REFERENCE_DURATION = 60.0;

export function applyMotion(
  motion: MotionPreset,
  elapsedSeconds: number,
  duration: number,
  intensity: number,
  rect: { x: number; y: number; w: number; h: number },
  subject?: { x: number; y: number },
) {
  if (motion === "none") return rect;
  const amount = Math.max(0.02, Math.min(0.6, intensity));
  const rate = amount / MOTION_REFERENCE_DURATION;
  const maxScale = 1 + amount * (MAX_SCALE_REFERENCE_DURATION / MOTION_REFERENCE_DURATION);
  const peak = 1 + amount;
  let scaleMul = 1;
  let panX = subject?.x ?? 0.5;
  let panY = subject?.y ?? 0.5;
  if (motion === "zoom-in" || motion === "zoom-in-subject") {
    scaleMul = Math.min(maxScale, 1 + rate * elapsedSeconds);
  } else if (motion === "zoom-out" || motion === "zoom-out-subject") {
    scaleMul = Math.min(maxScale, 1 + rate * (duration - elapsedSeconds));
  } else if (motion === "zoom-pulse") {
    const half = duration / 2;
    scaleMul = elapsedSeconds < half
      ? Math.min(maxScale, 1 + rate * elapsedSeconds)
      : Math.max(1, Math.min(maxScale, 1 + rate * half) - rate * (elapsedSeconds - half));
    panX = 0.5;
    panY = 0.5;
  } else if (motion === "pan-left") {
    scaleMul = peak;
    panX = 1 - Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
    panY = 0.5;
  } else if (motion === "pan-right") {
    scaleMul = peak;
    panX = Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
    panY = 0.5;
  } else if (motion === "cuts") {
    // Mirrors video_export_engine.py's "cuts" handling exactly: a hard-cut
    // step function between 3 fixed crops (wide, subject, complementary
    // corner), not a continuous animation — matches the actual export,
    // which independently encodes each third as its own segment.
    const cutAnchors: [number, number, number][] = [
      [0.5, 0.5, 1.0],
      [subject?.x ?? 0.5, subject?.y ?? 0.5, Math.min(maxScale, peak + 0.3)],
      [1 - (subject?.x ?? 0.5), 1 - (subject?.y ?? 0.5), Math.min(maxScale, peak + 0.3)],
    ];
    const third = duration / 3;
    const cutIndex = Math.min(2, Math.floor(elapsedSeconds / Math.max(0.001, third)));
    const [cx, cy, cscale] = cutAnchors[cutIndex];
    scaleMul = cscale;
    panX = cx;
    panY = cy;
  } else if (motion === "ken-burns") {
    // Classic Ken Burns: zoom in steadily while panning from an off-center
    // starting point toward the frame's center, so the motion reads as a
    // single deliberate push-in rather than a plain static zoom.
    scaleMul = Math.min(maxScale, 1 + rate * elapsedSeconds);
    const t = Math.min(1, elapsedSeconds / MOTION_REFERENCE_DURATION);
    const startX = subject?.x ?? 0.35;
    const startY = subject?.y ?? 0.35;
    panX = startX + (0.5 - startX) * t;
    panY = startY + (0.5 - startY) * t;
  }
  const w = rect.w * scaleMul;
  const h = rect.h * scaleMul;
  return { x: rect.x - (w - rect.w) * panX, y: rect.y - (h - rect.h) * panY, w, h };
}

// Matches the export engine's fade window: proportional to the clip's own
// duration (~8%), floored so short clips still get a perceptible fade, and
// capped at half the duration so in+out fades on a short clip never overlap.
export function fadeOverlay(
  transitionIn: string,
  transitionOut: string,
  elapsedSeconds: number,
  duration: number,
): { alpha: number; color: string } {
  const fadeDuration = Math.max(0.15, Math.min(duration / 2, duration * 0.08));
  if (fadeDuration <= 0) return { alpha: 0, color: "#000000" };
  const isFadeLike = (transition: string) => transition === "fade" || transition === "dip-to-white";
  const colorFor = (transition: string) => (transition === "dip-to-white" ? "#ffffff" : "#000000");
  let alpha = 0;
  let color = "#000000";
  if (isFadeLike(transitionIn) && elapsedSeconds < fadeDuration) {
    const candidate = 1 - elapsedSeconds / fadeDuration;
    if (candidate > alpha) { alpha = candidate; color = colorFor(transitionIn); }
  }
  const timeFromEnd = duration - elapsedSeconds;
  if (isFadeLike(transitionOut) && timeFromEnd < fadeDuration) {
    const candidate = 1 - timeFromEnd / fadeDuration;
    if (candidate > alpha) { alpha = candidate; color = colorFor(transitionOut); }
  }
  return { alpha: Math.max(0, Math.min(1, alpha)), color };
}

// Shared with the export engine's ffmpeg `eq` filter mapping in
// video_export_engine.py — `brightness` here is additive (matches eq's
// -1..1 range), `contrast`/`saturation` are multiplicative around 1 (matches
// both eq and CSS filter-function semantics), so the same numbers drop
// straight into both without conversion beyond CSS brightness() being
// multiplicative.
const COLOR_FILTER_TARGETS: Record<string, { brightness: number; contrast: number; saturation: number }> = {
  none: { brightness: 0, contrast: 1, saturation: 1 },
  warm: { brightness: 0.03, contrast: 1.05, saturation: 1.25 },
  cool: { brightness: -0.02, contrast: 1.05, saturation: 0.9 },
  cinematic: { brightness: -0.05, contrast: 1.15, saturation: 0.85 },
  bright: { brightness: 0.12, contrast: 1.02, saturation: 1.08 },
  muted: { brightness: 0.02, contrast: 0.95, saturation: 0.55 },
  dark: { brightness: -0.18, contrast: 1.12, saturation: 0.9 },
};

export function buildColorFilterCss(preset: string, intensityPercent: number): string {
  const target = COLOR_FILTER_TARGETS[preset];
  if (!target || preset === "none") return "none";
  const t = Math.max(0, Math.min(100, intensityPercent)) / 100;
  const brightness = 1 + target.brightness * t;
  const contrast = 1 + (target.contrast - 1) * t;
  const saturation = 1 + (target.saturation - 1) * t;
  return `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturation.toFixed(3)})`;
}

/** Draws captions burned in, matching the export engine's ASS burn-in (font,
 * weight, color, outline, shadow, position), scaled for legibility at the
 * editor's small preview canvas rather than an exact pixel-ratio match to
 * the export resolution — the default 22px is comfortably readable on a
 * full 1080p export but would be nearly invisible at the preview canvas's
 * native size. `activeWordIndex` (index into `text.split(/\s+/)`) recolors
 * just that one word — mirrors the export's per-word-window ASS Dialogue
 * lines, so the in-app preview matches what gets burned in. */
export function drawCaptionText(
  ctx: CanvasRenderingContext2D, width: number, height: number, text: string, style: Required<CaptionStyle>,
  activeWordIndex: number | null,
) {
  const fontSize = Math.max(14, Math.round((style.fontSizePx / 22) * height * 0.045));
  const weight = style.bold ? 900 : 400;
  ctx.font = `${weight} ${fontSize}px "${style.fontFamily}", Arial, sans-serif`;
  ctx.textBaseline = "alphabetic";
  const maxWidth = width * 0.86;
  const words = text.split(/\s+/);
  const lines: { word: string; index: number }[][] = [];
  let line: { word: string; index: number }[] = [];
  let lineText = "";
  words.forEach((word, index) => {
    const test = lineText ? `${lineText} ${word}` : word;
    if (lineText && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = [{ word, index }];
      lineText = word;
    } else {
      line.push({ word, index });
      lineText = test;
    }
  });
  if (line.length) lines.push(line);

  const lineHeight = fontSize * 1.25;
  const blockHeight = lines.length * lineHeight;
  const margin = height * 0.05;
  let startY: number;
  if (style.position === "top") {
    startY = margin + lineHeight * 0.8;
  } else if (style.position === "middle") {
    startY = (height - blockHeight) / 2 + lineHeight * 0.8;
  } else {
    startY = height - margin - blockHeight + lineHeight * 0.8;
  }
  const outlineWidth = Math.max(1, (style.outlineWidthPx / 2) * fontSize * 0.16);
  ctx.lineJoin = "round";
  ctx.textAlign = "left";
  const highlightEnabled = style.wordHighlight.enabled && activeWordIndex !== null;
  const highlightColor = style.wordHighlight.color ?? "#FFEB3B";

  lines.forEach((lineWords, lineIndex) => {
    const y = startY + lineIndex * lineHeight;
    const fullLineText = lineWords.map((w) => w.word).join(" ");
    let x = width / 2 - ctx.measureText(fullLineText).width / 2;
    lineWords.forEach(({ word, index }, wordPos) => {
      const isActive = highlightEnabled && index === activeWordIndex;
      if (outlineWidth > 0) {
        ctx.shadowColor = "transparent";
        ctx.lineWidth = outlineWidth;
        ctx.strokeStyle = withAlpha(style.outlineColor, style.opacity);
        ctx.strokeText(word, x, y);
      }
      if (style.shadow.enabled) {
        const distance = style.shadow.distance ?? 2;
        const angleRad = ((style.shadow.angle ?? 90) * Math.PI) / 180;
        ctx.shadowColor = withAlpha(style.shadow.color ?? "#000000", style.shadow.opacity ?? 70);
        ctx.shadowBlur = ((style.shadow.blur ?? 30) / 100) * MAX_SHADOW_BLUR_PX;
        ctx.shadowOffsetX = distance * Math.cos(angleRad);
        ctx.shadowOffsetY = distance * Math.sin(angleRad);
      } else {
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = isActive ? highlightColor : withAlpha(style.color, style.opacity);
      ctx.fillText(word, x, y);
      ctx.shadowColor = "transparent";
      const wordWithTrailingSpace = wordPos < lineWords.length - 1 ? `${word} ` : word;
      x += ctx.measureText(wordWithTrailingSpace).width;
    });
  });
}

// Matches video_export_engine.py's expand_join_transitions formula exactly,
// so the preview's transition window lines up with what export will do.
export function joinTransitionSeconds(durationA: number, durationB: number): number {
  return Math.max(0.2, Math.min(0.75, Math.min(durationA, durationB) / 3));
}

// Mirrors JOIN_TRANSITIONS in video_export_engine.py — these need both
// neighboring clips' pixel data blended together, unlike cut/fade/dip-to-white.
export const JOIN_TRANSITIONS = new Set(["cross-fade", "slide-left", "slide-right", "zoom-blur", "whip-pan", "blur-transition"]);

type ClipLike = {
  id: string;
  renderId: string | null;
  /** Set for clipKind 'imported-still' — falls back to this when renderId is
   * absent, so an imported still draws from its media library asset instead. */
  mediaLibraryAssetId: string | null;
  startSeconds: number;
  endSeconds: number;
  motionPreset: MotionPreset;
  motionIntensity: number;
  colorFilterPreset: string;
  colorFilterIntensity: number;
};

/** Same leading-gap handling as the export engine: a small silence before
 * the first still (start > 0) should still show that still, not black —
 * whatever time is asked for before the first clip's nominal start just
 * renders as that clip. Matches export always opening on the first still
 * (see build_timeline_export_manifest), so preview and export agree. */
export function findClipAtTime<T extends { startSeconds: number; endSeconds: number }>(clips: T[], time: number): T | undefined {
  const first = clips[0];
  if (first && time < first.startSeconds) return first;
  return clips.find((c) => time >= c.startSeconds && time < c.endSeconds);
}

/** Draws just a still clip's own image content (motion + color filter), with
 * an optional slide/blur/scale tweak for join-transition blending — no fade
 * overlay, that's layered on separately by the caller. Returns false if the
 * image isn't loaded yet (nothing drawn). `getImage`/`getSubject` are
 * injected rather than closed over so this stays decoupled from React state
 * — see useTimelineAssets for the cache backing them. */
export function drawStillClipContent(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  clip: ClipLike,
  elapsedSeconds: number,
  getImage: (assetId: string) => HTMLImageElement | null,
  getSubject: (renderId: string) => { x: number; y: number } | undefined,
  options?: { translateXPx?: number; extraScale?: number; blurPx?: number },
): boolean {
  const assetId = clip.renderId ?? clip.mediaLibraryAssetId;
  if (!assetId) return false;
  const img = getImage(assetId);
  if (!img) return false;
  // Cover-fill (not contain): when the still's natural ratio doesn't match
  // the canvas's target aspect ratio, this crops the overflow rather than
  // letterboxing — matches the export engine's crop-based scaling. When the
  // ratios do match (the common case), Math.max and Math.min agree exactly.
  const scale = Math.max(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
  const base = {
    w: img.naturalWidth * scale,
    h: img.naturalHeight * scale,
    x: (canvas.width - img.naturalWidth * scale) / 2,
    y: (canvas.height - img.naturalHeight * scale) / 2,
  };
  const clipDuration = clip.endSeconds - clip.startSeconds;
  // Zoom-to-subject is only ever detected against a generated render — an
  // imported still (no renderId) just falls back to frame-center motion.
  const subject = clip.renderId ? getSubject(clip.renderId) : undefined;
  const rect = applyMotion(clip.motionPreset, Math.max(0, elapsedSeconds), clipDuration, clip.motionIntensity, base, subject);
  const extraScale = options?.extraScale ?? 1;
  const w = rect.w * extraScale;
  const h = rect.h * extraScale;
  const x = rect.x - (w - rect.w) / 2 + (options?.translateXPx ?? 0);
  const y = rect.y - (h - rect.h) / 2;
  const colorCss = buildColorFilterCss(clip.colorFilterPreset, clip.colorFilterIntensity);
  const blurCss = options?.blurPx ? `blur(${options.blurPx.toFixed(1)}px)` : "";
  ctx.filter = [colorCss === "none" ? "" : colorCss, blurCss].filter(Boolean).join(" ") || "none";
  ctx.drawImage(img, x, y, w, h);
  ctx.filter = "none";
  return true;
}

/** Preview approximation of a join transition (cross-fade/slide/zoom-blur) —
 * export's `expand_join_transitions`/`xfade` produce the authoritative
 * result; this only needs to look reasonably close while scrubbing/playing.
 * `elapsedA`/`elapsedB` are each clip's own natural elapsed time (clip B's
 * starts from 0, "borrowed" a little early relative to its nominal start —
 * unlike export, the live preview has no fixed frame budget to conserve, so
 * there's no need to virtually extend clip A the way export does). */
export function drawJoinTransitionFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  clipA: ClipLike,
  clipB: ClipLike,
  elapsedA: number,
  elapsedB: number,
  progress: number,
  transitionType: string,
  getImage: (renderId: string) => HTMLImageElement | null,
  getSubject: (renderId: string) => { x: number; y: number } | undefined,
) {
  if (transitionType === "slide-left" || transitionType === "slide-right") {
    const direction = transitionType === "slide-left" ? -1 : 1;
    drawStillClipContent(ctx, canvas, clipA, elapsedA, getImage, getSubject, { translateXPx: direction * progress * canvas.width });
    drawStillClipContent(ctx, canvas, clipB, elapsedB, getImage, getSubject, { translateXPx: -direction * (1 - progress) * canvas.width });
    return;
  }
  if (transitionType === "zoom-blur") {
    drawStillClipContent(ctx, canvas, clipA, elapsedA, getImage, getSubject, { blurPx: progress * 6 });
    ctx.globalAlpha = progress;
    drawStillClipContent(ctx, canvas, clipB, elapsedB, getImage, getSubject, {
      extraScale: 1 + (1 - progress) * 0.25,
      blurPx: (1 - Math.abs(progress - 0.5) * 2) * 4,
    });
    ctx.globalAlpha = 1;
    return;
  }
  if (transitionType === "whip-pan") {
    // Fast blur-pan handoff — approximated as a directional slide with heavy
    // motion blur peaking mid-transition (the real export's ffmpeg `hblur`
    // xfade reads similarly at the short duration this transition uses).
    drawStillClipContent(ctx, canvas, clipA, elapsedA, getImage, getSubject, {
      translateXPx: -progress * canvas.width * 0.4,
      blurPx: Math.sin(progress * Math.PI) * 14,
    });
    ctx.globalAlpha = progress;
    drawStillClipContent(ctx, canvas, clipB, elapsedB, getImage, getSubject, {
      translateXPx: (1 - progress) * canvas.width * 0.4,
      blurPx: Math.sin(progress * Math.PI) * 14,
    });
    ctx.globalAlpha = 1;
    return;
  }
  if (transitionType === "blur-transition") {
    // Softer, slower blur dissolve — no directional slide, just a shared
    // blur peak at the midpoint of a longer transition window.
    drawStillClipContent(ctx, canvas, clipA, elapsedA, getImage, getSubject, { blurPx: progress * 16 });
    ctx.globalAlpha = progress;
    drawStillClipContent(ctx, canvas, clipB, elapsedB, getImage, getSubject, { blurPx: (1 - progress) * 16 });
    ctx.globalAlpha = 1;
    return;
  }
  // cross-fade, and the fallback for anything unrecognized.
  drawStillClipContent(ctx, canvas, clipA, elapsedA, getImage, getSubject);
  ctx.globalAlpha = progress;
  drawStillClipContent(ctx, canvas, clipB, elapsedB, getImage, getSubject);
  ctx.globalAlpha = 1;
}

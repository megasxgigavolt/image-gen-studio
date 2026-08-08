import React from "react";
import { AbsoluteFill, Img, interpolate, random, staticFile, useCurrentFrame, Easing } from "remotion";
import type { EnvironmentEffect, MaskShape, MotionClipProps, MotionEasing, SpeedCurve } from "./types";

// ONE generic renderer for every recipe the AI's fixed effect catalog can
// produce (see types.ts's module doc) — there is no per-effect component or
// switch statement. Every primitive below is independently optional/neutral
// by default, so an arbitrary combination the AI composes always renders
// something coherent. Adding a genuinely new *technique* means adding a
// primitive here; adding a new *named effect* to the catalog never touches
// this file, it's just a different, documented combination of the dials
// already below (see motion_graphics_engine.py's SYSTEM_PROMPT_TEMPLATE for
// exactly which dials each named effect sets).

const mapEasing = (easing: MotionEasing) => {
  switch (easing) {
    case "linear":
      return Easing.linear;
    case "easeIn":
      return Easing.in(Easing.ease);
    case "easeOut":
      return Easing.out(Easing.ease);
    case "cubic":
      return Easing.inOut(Easing.cubic);
    case "elastic":
      return Easing.elastic(1);
    case "ease":
    default:
      return Easing.inOut(Easing.ease);
  }
};

// Tier-4 "speed_ramp": remaps the plain 0-1 progress curve to a non-linear
// pace. Applied on TOP of the normal easing (see `easingFn` below) — pure
// 0->0 / 1->1 functions, so it composes without disturbing where the move
// starts/ends, just how it gets there.
const applySpeedCurve = (t: number, curve: SpeedCurve): number => {
  const clamped = Math.max(0, Math.min(1, t));
  switch (curve) {
    case "punch_in_hold":
      return 1 - (1 - clamped) ** 3; // fast initial move, then eases into a hold
    case "slow_fast_slow":
      return clamped * clamped * (3 - 2 * clamped); // smoothstep — fast middle
    case "fast_start_ease_out":
      return Math.sin((clamped * Math.PI) / 2); // quick start, gentle finish
    case "linear_pace":
    default:
      return clamped;
  }
};

// Tier-4 "freeze_frame": remaps real frame -> "effective" frame so the
// camera move visibly pauses at `freezeStart` for `freezeHold` real frames,
// then resumes and still reaches full completion exactly at
// `durationInFrames` — rather than just clamping progress (which would snap
// forward the instant the hold ends). Frames before the hold pass through
// unchanged; frames after it are rescaled so the remaining move fits the
// remaining real time.
const remapFrameForFreeze = (frame: number, durationInFrames: number, freezeStart: number, freezeHold: number): number => {
  if (freezeHold <= 0) return frame;
  const freezeEnd = freezeStart + freezeHold;
  if (frame <= freezeStart) return frame;
  if (frame <= freezeEnd) return freezeStart;
  const postSpanReal = Math.max(1, durationInFrames - freezeEnd);
  const postSpanEffective = Math.max(0, durationInFrames - freezeStart);
  return freezeStart + ((frame - freezeEnd) / postSpanReal) * postSpanEffective;
};

const buildMaskImage = (shape: MaskShape, radiusFrac: number, x: number, y: number, softness: number, diagonal: number) => {
  const clampedSoftness = Math.max(0, Math.min(1, softness));
  if (shape === "circle") {
    const radiusPx = Math.max(0, radiusFrac * diagonal);
    const blackStopPercent = 97 - clampedSoftness * 57; // 0 -> hard iris edge, 1 -> soft rack-focus blend
    return `radial-gradient(circle ${radiusPx}px at ${x * 100}% ${y * 100}%, black ${blackStopPercent}%, transparent 100%)`;
  }
  const featherPercent = 2 + clampedSoftness * 40;
  const edgePercent = Math.max(0, Math.min(100, radiusFrac * 100));
  const direction = shape === "linear-h" ? "to right" : "to bottom";
  const from = Math.max(0, edgePercent - featherPercent);
  const to = Math.min(100, edgePercent + featherPercent);
  return `linear-gradient(${direction}, black ${from}%, transparent ${to}%)`;
};

// Tier-2 depth effects: an approximate foreground/background split (no true
// image segmentation available — see SOP for why) using a soft elliptical
// mask centered on the AI-marked `subjectRegion`. Generous softness keeps
// the cutout from reading as an obvious rectangle/oval.
const buildSubjectCutoutMask = (
  regionX: number, regionY: number, regionW: number, regionH: number, softness: number, width: number, height: number,
) => {
  const cx = (regionX + regionW / 2) * 100;
  const cy = (regionY + regionH / 2) * 100;
  const rxPx = Math.max(8, (regionW / 2) * width);
  const ryPx = Math.max(8, (regionH / 2) * height);
  const clampedSoftness = Math.max(0, Math.min(1, softness));
  const blackStopPercent = Math.max(10, 65 - clampedSoftness * 45);
  return `radial-gradient(ellipse ${rxPx}px ${ryPx}px at ${cx}% ${cy}%, black ${blackStopPercent}%, transparent 100%)`;
};

interface Particle {
  left: string;
  top: string;
  size: number;
  opacity: number;
  blurPx: number;
  rotationDeg?: number;
}

// Tier-5 environmental overlays: a lightweight deterministic particle system
// (not a physical simulation) layered on top of the main image. `random(seed)`
// (not Math.random) keeps every particle's motion a pure function of frame
// number, required since Remotion renders frames independently across
// parallel workers. `intensity` (0-1) scales both particle count and opacity.
function buildEnvironmentParticles(effect: EnvironmentEffect, intensity: number, frame: number, width: number, height: number): Particle[] {
  if (effect === "none" || intensity <= 0) return [];
  const density = Math.max(0.15, Math.min(1, intensity));

  const drifting = (count: number, fallSpeed: number, driftAmp: number, sizeRange: [number, number], opacityRange: [number, number]) => {
    const particles: Particle[] = [];
    for (let i = 0; i < count; i++) {
      const seed = `${effect}-${i}`;
      const x0 = random(`${seed}-x`);
      const y0 = random(`${seed}-y`);
      const speed = 0.4 + random(`${seed}-speed`) * 0.6;
      const size = sizeRange[0] + random(`${seed}-size`) * (sizeRange[1] - sizeRange[0]);
      const phase = random(`${seed}-phase`) * Math.PI * 2;
      const t = (y0 + (frame * fallSpeed * speed) / height) % 1;
      const driftPx = Math.sin(frame / 30 + phase) * driftAmp;
      const opacity = opacityRange[0] + random(`${seed}-op`) * (opacityRange[1] - opacityRange[0]);
      particles.push({
        left: `calc(${x0 * 100}% + ${driftPx}px)`,
        top: `${t * 100}%`,
        size,
        opacity: opacity * density,
        blurPx: 0,
      });
    }
    return particles;
  };

  switch (effect) {
    case "rain": {
      const count = Math.round(14 + density * 46);
      const particles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const seed = `rain-${i}`;
        const x0 = random(`${seed}-x`);
        const y0 = random(`${seed}-y`);
        const speed = 1.6 + random(`${seed}-speed`) * 1.2;
        const t = (y0 + (frame * speed) / height) % 1;
        particles.push({ left: `${x0 * 100}%`, top: `${t * 100}%`, size: 1.5, opacity: (0.25 + random(`${seed}-op`) * 0.3) * density, blurPx: 0, rotationDeg: 12 });
      }
      return particles;
    }
    case "snow":
      return drifting(Math.round(10 + density * 30), 0.35, 14, [2, 5], [0.35, 0.85]);
    case "dust":
    case "floating_particles":
      return drifting(Math.round(8 + density * 22), 0.12, 10, [1.5, 4], [0.15, 0.5]);
    case "fire_embers":
      return drifting(Math.round(6 + density * 18), -0.3, 8, [1.5, 3.5], [0.4, 0.9]);
    case "smoke":
    case "fog": {
      const count = Math.round(3 + density * 4);
      const particles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const seed = `${effect}-${i}`;
        const x0 = random(`${seed}-x`);
        const y0 = random(`${seed}-y`);
        const speed = 0.06 + random(`${seed}-speed`) * 0.08;
        const t = (y0 + (frame * speed) / height + 1) % 1;
        const driftPx = Math.sin(frame / 90 + i) * 40;
        particles.push({
          left: `calc(${x0 * 100}% + ${driftPx}px)`,
          top: `${t * 100}%`,
          size: width * (0.25 + random(`${seed}-size`) * 0.2),
          opacity: (0.08 + random(`${seed}-op`) * 0.1) * density,
          blurPx: 40,
        });
      }
      return particles;
    }
    case "light_rays": {
      const count = Math.round(2 + density * 3);
      const particles: Particle[] = [];
      for (let i = 0; i < count; i++) {
        const seed = `rays-${i}`;
        particles.push({
          left: `${(20 + random(`${seed}-x`) * 60).toFixed(1)}%`,
          top: "-20%",
          size: width * (0.5 + random(`${seed}-size`) * 0.4),
          opacity: (0.1 + random(`${seed}-op`) * 0.12) * density,
          blurPx: 30,
          rotationDeg: -20 + random(`${seed}-rot`) * 40 + Math.sin(frame / 200 + i) * 3,
        });
      }
      return particles;
    }
    default:
      return [];
  }
}

function EnvironmentOverlay({ effect, intensity, frame, width, height }: { effect: EnvironmentEffect; intensity: number; frame: number; width: number; height: number }) {
  const particles = buildEnvironmentParticles(effect, intensity, frame, width, height);
  if (particles.length === 0) return null;
  const isRain = effect === "rain";
  const isRay = effect === "light_rays";
  const isSoft = effect === "smoke" || effect === "fog";
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: isRay ? "screen" : "normal" }}>
      {particles.map((p, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: p.left,
            top: p.top,
            width: isRay ? p.size : isRain ? 1.5 : p.size,
            height: isRay ? p.size * 2.4 : isRain ? p.size * 9 : p.size,
            borderRadius: isRay ? 0 : "50%",
            background: isRay
              ? "linear-gradient(to bottom, rgba(255,250,220,0.9), transparent 75%)"
              : effect === "fire_embers"
                ? "radial-gradient(circle, rgba(255,170,60,1), rgba(255,90,20,0.5) 70%, transparent 100%)"
                : isRain
                  ? "linear-gradient(to bottom, rgba(200,220,255,0.9), transparent)"
                  : isSoft
                    ? "radial-gradient(circle, rgba(230,230,235,0.9), transparent 70%)"
                    : "rgba(255,255,255,0.95)",
            opacity: p.opacity,
            filter: p.blurPx ? `blur(${p.blurPx}px)` : undefined,
            transform: p.rotationDeg ? `rotate(${p.rotationDeg}deg)` : undefined,
          }}
        />
      ))}
    </AbsoluteFill>
  );
}

export const MotionClip: React.FC<MotionClipProps> = ({ imagePath, recipe, durationInFrames, width, height }) => {
  const frame = useCurrentFrame();
  const src = staticFile(imagePath);
  const diagonal = Math.sqrt(width * width + height * height);
  const easingFn = mapEasing(recipe.easing);

  // --- Tier-4 pacing: freeze-frame hold, then speed-ramp curve, both
  // layered on top of the base easing. Only the camera-move-driving progress
  // below is affected — the fade envelope always runs on real time. ---
  const freezeStart = recipe.storyEffect === "freeze_frame"
    ? Math.max(1, Math.min(Math.round(recipe.freezeAtProgress * durationInFrames), durationInFrames - 2))
    : 0;
  const freezeHold = recipe.storyEffect === "freeze_frame"
    ? Math.max(0, Math.min(recipe.freezeHoldFrames, durationInFrames - freezeStart - 1))
    : 0;
  const effectiveFrame = remapFrameForFreeze(frame, durationInFrames, freezeStart, freezeHold);

  let overallProgress = interpolate(effectiveFrame, [0, durationInFrames], [0, 1], {
    easing: easingFn,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (recipe.storyEffect === "speed_ramp") {
    overallProgress = applySpeedCurve(overallProgress, recipe.speedCurve);
  }

  // Fade envelope — clamp each half to at most half the clip so a very short
  // clip with generous fade settings can't invert. Remotion's `interpolate`
  // requires strictly increasing breakpoints, so a recipe with fadeIn/
  // fadeOutFrames at or near 0 (a valid, deliberate "hard cut" choice) gets
  // nudged apart by a sub-frame epsilon rather than colliding into duplicate
  // breakpoints, which would otherwise crash the render outright. Always
  // driven by the real `frame`, never the freeze-remapped one.
  const EPSILON_FRAMES = 0.001;
  const fadeIn = Math.max(0, Math.min(recipe.fadeInFrames, durationInFrames / 2));
  const fadeOut = Math.max(0, Math.min(recipe.fadeOutFrames, durationInFrames / 2));
  const fadeInEnd = Math.max(EPSILON_FRAMES, fadeIn);
  const fadeOutStart = Math.min(
    durationInFrames - EPSILON_FRAMES,
    Math.max(fadeInEnd + EPSILON_FRAMES, durationInFrames - fadeOut)
  );
  const envelopeOpacity = interpolate(
    frame,
    [0, fadeInEnd, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // --- Tier 1: camera move. Tier-4 path_animation overrides the pan with a
  // multi-waypoint route; everything else still comes from the plain 2-point
  // scale/pan/rotation interpolation. ---
  const hasPath = recipe.storyEffect === "path_animation" && !!recipe.pathPoints && recipe.pathPoints.length >= 2;
  let translateXPercent: number;
  let translateYPercent: number;
  if (hasPath) {
    const points = recipe.pathPoints!;
    const keyTimes = points.map((_, i) => i / (points.length - 1));
    translateXPercent = interpolate(overallProgress, keyTimes, points.map((p) => p.x), { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    translateYPercent = interpolate(overallProgress, keyTimes, points.map((p) => p.y), { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  } else {
    translateXPercent = interpolate(overallProgress, [0, 1], [recipe.panXFrom, recipe.panXTo]);
    translateYPercent = interpolate(overallProgress, [0, 1], [recipe.panYFrom, recipe.panYTo]);
  }
  let scale = interpolate(overallProgress, [0, 1], [recipe.scaleFrom, recipe.scaleTo]);
  const rotationDeg = interpolate(overallProgress, [0, 1], [recipe.rotationFromDeg, recipe.rotationToDeg]);

  // Safety floor, not a style choice: a pan and/or rotation with too little
  // scale margin reveals empty space beyond the source image's edge (the
  // image is frame-sized before this transform, so translating it without
  // enough overscan runs it off the visible frame on one side — confirmed
  // by rendering a worst-case pan and inspecting the actual frames).
  // Recomputed every frame from whatever pan/rotation actually land there,
  // so it's correct regardless of how scale/pan/rotation happen to
  // interpolate relative to each other — this can only ever raise `scale`
  // above what the recipe asked for, never lower it.
  const panMarginNeeded = 1 + Math.max(Math.abs(translateXPercent), Math.abs(translateYPercent)) * 0.028;
  const rotationRad = (Math.abs(rotationDeg) * Math.PI) / 180;
  const aspect = width / height;
  const rotationMarginNeeded = Math.max(
    Math.cos(rotationRad) + Math.sin(rotationRad) / aspect,
    Math.cos(rotationRad) + Math.sin(rotationRad) * aspect
  );
  scale = Math.max(scale, panMarginNeeded, rotationMarginNeeded);

  // --- Motion energy: directional blur + ghost trails + subtle handheld
  // shake, all deterministic functions of frame/progress. ---
  const speed = Math.sin(overallProgress * Math.PI) * recipe.motionBlurStrength;
  const motionBlurPx = speed * 7;
  const shakePx = Math.sin(frame * 1.7) * speed * recipe.shakeAmount;
  const baseTransform = `translate(${translateXPercent}%, ${translateYPercent}%) translate(${shakePx}px, ${shakePx * 0.6}px) scale(${scale}) rotate(${rotationDeg}deg)`;
  const transformOrigin = `${recipe.originX}% ${recipe.originY}%`;

  // --- Tier 2: depth & realism — an approximate foreground/background split
  // when active, otherwise a single full-frame layer. ---
  const hasDepth = recipe.depthEffect !== "none";
  const fgScale = interpolate(overallProgress, [0, 1], [recipe.fgScaleFrom, recipe.fgScaleTo]);
  const fgScaleSafe = Math.max(fgScale, panMarginNeeded, rotationMarginNeeded);
  const fgTranslateX = interpolate(overallProgress, [0, 1], [recipe.fgPanXFrom, recipe.fgPanXTo]);
  const fgTranslateY = interpolate(overallProgress, [0, 1], [recipe.fgPanYFrom, recipe.fgPanYTo]);
  const fgTransform = `translate(${fgTranslateX}%, ${fgTranslateY}%) scale(${fgScaleSafe}) rotate(${rotationDeg}deg)`;
  const bgBlurPx = interpolate(overallProgress, [0, 1], [recipe.bgBlurFromPx, recipe.bgBlurToPx]);
  const subjectMask = hasDepth
    ? buildSubjectCutoutMask(recipe.subjectRegionX, recipe.subjectRegionY, recipe.subjectRegionW, recipe.subjectRegionH, recipe.subjectMaskSoftness, width, height)
    : undefined;

  // --- Tier 4 (focus_shift / general): whole-frame blur ---
  const blurPx = interpolate(overallProgress, [0, 1], [recipe.blurFromPx, recipe.blurToPx]) + motionBlurPx;

  // --- Tier 4 (mask_reveal / track_matte): reveal mask ---
  const hasMask = recipe.maskShape !== "none";
  let maskImage: string | undefined;
  if (hasMask) {
    const holdBefore = Math.min(recipe.maskHoldFrames ?? 0, Math.max(0, durationInFrames / 2));
    const revealWindow = Math.max(20, durationInFrames * 0.4);
    const maskProgress = interpolate(frame, [holdBefore, holdBefore + revealWindow], [0, 1], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const radiusFrac = interpolate(maskProgress, [0, 1], [recipe.maskFromRadius, recipe.maskToRadius]);
    maskImage = buildMaskImage(recipe.maskShape, radiusFrac, recipe.maskX, recipe.maskY, recipe.maskSoftness, diagonal);
  }

  // Blur differential + a mask together reads as a rack-focus (blurred wide
  // shot underneath, sharp masked circle on top). A mask with no blur
  // differential is a plain reveal wipe; blur with no mask is a plain focus
  // fade across the whole frame.
  const needsBlurLayer = hasMask && !hasDepth && Math.abs(recipe.blurToPx - recipe.blurFromPx) > 0.01;

  // --- Color / light ---
  const saturation = interpolate(overallProgress, [0, 1], [recipe.saturationFrom, recipe.saturationTo]);
  const glowPulse = recipe.glowFlicker > 0
    ? Math.max(
        0.35,
        Math.min(
          1,
          1 - recipe.glowFlicker * 0.7 +
            recipe.glowFlicker * 0.75 * Math.sin(frame / 5) +
            recipe.glowFlicker * 0.5 * Math.sin(frame / 2.3 + 1.4) +
            recipe.glowFlicker * 0.4 * (random(`glow-${Math.floor(frame / 2)}`) - 0.5)
        )
      )
    : 1;
  const vignettePx = interpolate(recipe.vignette, [0, 1], [0, 190]);

  const ghostOffsets = recipe.motionBlurStrength > 0 ? [14, 8, 4] : [];

  return (
    <AbsoluteFill style={{ backgroundColor: "#0d0a06", opacity: envelopeOpacity }}>
      {ghostOffsets.map((off, i) => (
        <AbsoluteFill
          key={i}
          style={{
            transform: `${baseTransform} translateX(${off * speed}px)`,
            transformOrigin,
            opacity: 0.14 * Math.abs(speed),
            filter: `blur(${motionBlurPx + 4}px)`,
          }}
        >
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ))}

      {needsBlurLayer && (
        <AbsoluteFill style={{ transform: baseTransform, transformOrigin }}>
          <Img
            src={src}
            style={{ width: "100%", height: "100%", objectFit: "cover", filter: `blur(${blurPx}px) saturate(${saturation})` }}
          />
        </AbsoluteFill>
      )}

      <AbsoluteFill
        style={{
          transform: baseTransform,
          transformOrigin,
          ...(maskImage ? { maskImage, WebkitMaskImage: maskImage } : {}),
        }}
      >
        {hasDepth ? (
          <>
            <AbsoluteFill style={{ transform: baseTransform, transformOrigin }}>
              <Img
                src={src}
                style={{ width: "100%", height: "100%", objectFit: "cover", filter: `blur(${bgBlurPx}px) saturate(${saturation})` }}
              />
            </AbsoluteFill>
            <AbsoluteFill style={{ transform: fgTransform, transformOrigin, maskImage: subjectMask, WebkitMaskImage: subjectMask }}>
              <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", filter: `saturate(${saturation})` }} />
            </AbsoluteFill>
          </>
        ) : (
          <Img
            src={src}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              filter: needsBlurLayer ? `saturate(${saturation})` : `blur(${blurPx}px) saturate(${saturation})`,
            }}
          />
        )}
      </AbsoluteFill>

      {recipe.glowColor && (
        <AbsoluteFill
          style={{
            background: `radial-gradient(circle at ${recipe.glowX * 100}% ${recipe.glowY * 100}%, ${recipe.glowColor}, transparent 45%)`,
            opacity: recipe.glowOpacity * glowPulse,
            mixBlendMode: "screen",
          }}
        />
      )}

      <EnvironmentOverlay effect={recipe.environmentEffect} intensity={recipe.environmentIntensity} frame={frame} width={width} height={height} />

      {recipe.vignette > 0 && (
        <AbsoluteFill style={{ boxShadow: `inset 0 0 ${vignettePx}px ${vignettePx * 0.55}px rgba(0,0,0,0.7)` }} />
      )}

      {recipe.motionBlurStrength > 0 && (
        <AbsoluteFill
          style={{
            background: "linear-gradient(90deg, rgba(0,0,0,0.3), transparent 20%, transparent 80%, rgba(0,0,0,0.3))",
            opacity: Math.min(1, Math.abs(speed)),
          }}
        />
      )}
    </AbsoluteFill>
  );
};

import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";
import type { PanelRect, SequentialPanelRevealSettings } from "../types";

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

// `rect` fractions (0-1) are converted to a CSS transform that centers that
// region of the source image and scales it to cover the whole composition
// frame — same "cover" math regardless of composition size, since it's
// computed from compWidth/compHeight passed in rather than a hardcoded 4K
// constant like the original one-off demo used.
const rectTransform = (
  rect: PanelRect | null,
  compWidth: number,
  compHeight: number,
  cropPadding: number
): Transform => {
  if (!rect) {
    return { scale: 1, tx: 0, ty: 0 };
  }
  const cx = (rect.x + rect.w / 2) * compWidth;
  const cy = (rect.y + rect.h / 2) * compHeight;
  const rectWidthPx = rect.w * compWidth;
  const rectHeightPx = rect.h * compHeight;
  const scale = Math.max(compWidth / rectWidthPx, compHeight / rectHeightPx) * cropPadding;
  return {
    scale,
    tx: compWidth / 2 - cx * scale,
    ty: compHeight / 2 - cy * scale,
  };
};

export const SequentialPanelReveal: React.FC<{
  imagePath: string;
  settings: SequentialPanelRevealSettings;
}> = ({ imagePath, settings }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();

  const panels = settings.panels && settings.panels.length > 0 ? settings.panels : null;
  const cropPadding = settings.cropPadding || 1.12;
  const holdStart = Math.min(settings.holdStartFrames ?? 20, durationInFrames - 1);

  // No panel data (older saved rows, or the model judged this image isn't
  // actually a grid): fall back to one smooth push over the whole image
  // instead of failing — same graceful-degradation spirit as the rest of
  // this engine's settings.
  if (!panels) {
    const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
      easing: Easing.inOut(Easing.ease),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
    const scale = interpolate(progress, [0, 1], [1.05, 1.2]);
    return (
      <AbsoluteFill style={{ backgroundColor: "#0d0a06" }}>
        <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}>
          <Img
            src={staticFile(imagePath)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  const arrivals = panels.map(
    (_, i) => holdStart + ((i + 1) * (durationInFrames - holdStart)) / panels.length
  );
  const keyframes = [0, ...arrivals];
  const states = [null, ...panels].map((rect) => rectTransform(rect, width, height, cropPadding));

  const easing = { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
  const scale = interpolate(frame, keyframes, states.map((s) => s.scale), easing);
  const tx = interpolate(frame, keyframes, states.map((s) => s.tx), easing);
  const ty = interpolate(frame, keyframes, states.map((s) => s.ty), easing);

  return (
    <AbsoluteFill style={{ background: "#0d0a06" }}>
      <AbsoluteFill style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: "0 0" }}>
        <Img src={staticFile(imagePath)} style={{ width, height }} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

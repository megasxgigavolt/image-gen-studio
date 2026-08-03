import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  random,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  Easing,
} from "remotion";
import type { CandlelightFlickerSettings } from "../types";

export const CandleFlicker: React.FC<{ imagePath: string; settings: CandlelightFlickerSettings }> = ({
  imagePath,
  settings,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.inOut(Easing.ease),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = interpolate(progress, [0, 1], [settings.scaleFrom, settings.scaleTo]);
  const amp = settings.flickerAmplitude;

  // Organic flicker: smooth sine base plus small deterministic noise —
  // never Math.random(), Remotion re-renders any given frame independently
  // (parallel workers), so the flicker must be a pure function of `frame`.
  const base =
    1 - amp * 0.7 +
    amp * 0.75 * Math.sin(frame / 5) +
    amp * 0.5 * Math.sin(frame / 2.3 + 1.4) +
    amp * 0.4 * (random(`flicker-${Math.floor(frame / 2)}`) - 0.5);
  const flicker = Math.max(0.35, Math.min(1, base));

  const opacity = interpolate(
    frame,
    [0, 18, durationInFrames - 18, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${settings.transformOriginX}% ${settings.transformOriginY}%`,
        }}
      >
        <Img
          src={staticFile(imagePath)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${settings.glowX * 100}% ${
            settings.glowY * 100
          }%, rgba(255,196,110,${0.55 * flicker}), transparent 32%)`,
          mixBlendMode: "screen",
        }}
      />

      <AbsoluteFill
        style={{
          boxShadow: `inset 0 0 ${140 - flicker * 30}px 60px rgba(10,6,2,${
            0.4 + (1 - flicker) * 0.15
          })`,
        }}
      />
    </AbsoluteFill>
  );
};

import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { OminousPushInSettings } from "../types";

export const OminousPushIn: React.FC<{ imagePath: string; settings: OminousPushInSettings }> = ({
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
  const saturate = interpolate(progress, [0, 1], [1, 0.72]);
  const vignette = interpolate(progress, [0, 1], [40, 130]);

  const glowPulse = 0.5 + 0.5 * Math.sin(frame / 14);
  const glowOpacity =
    interpolate(progress, [0, 0.3, 1], [0, 0.35, 0.55]) * (0.6 + 0.4 * glowPulse);

  const opacity = interpolate(
    frame,
    [0, 14, durationInFrames - 14, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${settings.transformOriginX}% ${settings.transformOriginY}%`,
          filter: `saturate(${saturate})`,
        }}
      >
        <Img
          src={staticFile(imagePath)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at ${settings.transformOriginX}% ${settings.transformOriginY}%, ${settings.glowColor}, transparent 45%)`,
          opacity: glowOpacity,
          mixBlendMode: "soft-light",
        }}
      />

      <AbsoluteFill
        style={{ boxShadow: `inset 0 0 ${vignette}px ${vignette * 0.55}px rgba(0,0,0,0.75)` }}
      />
    </AbsoluteFill>
  );
};

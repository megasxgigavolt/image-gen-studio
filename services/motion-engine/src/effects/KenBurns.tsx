import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { KenBurnsSettings } from "../types";

export const KenBurns: React.FC<{ imagePath: string; settings: KenBurnsSettings }> = ({
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
  const translateX = interpolate(progress, [0, 1], [-settings.panX / 2, settings.panX / 2]);
  const translateY = interpolate(progress, [0, 1], [-settings.panY / 2, settings.panY / 2]);

  const opacity = interpolate(
    frame,
    [0, 15, durationInFrames - 15, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale}) translate(${translateX}%, ${translateY}%)`,
          transformOrigin: "center center",
        }}
      >
        <Img
          src={staticFile(imagePath)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
      <AbsoluteFill style={{ boxShadow: "inset 0 0 180px 60px rgba(0,0,0,0.35)" }} />
    </AbsoluteFill>
  );
};

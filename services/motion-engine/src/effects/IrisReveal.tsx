import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { IrisRevealSettings } from "../types";

// Circular wipe reveal — for "unveiling" beats (an object presented to
// camera, a dramatic entrance) where a straight fade feels too flat. Holds
// closed briefly, then the iris opens from `startRadius` to `endRadius`
// (fractions of the frame diagonal) centered on the subject.
export const IrisReveal: React.FC<{ imagePath: string; settings: IrisRevealSettings }> = ({
  imagePath,
  settings,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const diagonal = Math.sqrt(width * width + height * height);

  const holdBefore = Math.min(settings.holdBeforeFrames ?? 8, durationInFrames / 3);
  const revealProgress = interpolate(
    frame,
    [holdBefore, holdBefore + Math.max(20, durationInFrames * 0.35)],
    [0, 1],
    { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const radiusPx = interpolate(
    revealProgress,
    [0, 1],
    [settings.startRadius * diagonal, settings.endRadius * diagonal]
  );

  const overallProgress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.inOut(Easing.ease),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(overallProgress, [0, 1], [settings.scaleFrom, settings.scaleTo]);

  const opacity = interpolate(
    frame,
    [0, durationInFrames - 14, durationInFrames],
    [1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const originXPercent = settings.revealX * 100;
  const originYPercent = settings.revealY * 100;
  const maskImage = `radial-gradient(circle ${radiusPx}px at ${originXPercent}% ${originYPercent}%, black 97%, transparent 100%)`;

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${originXPercent}% ${originYPercent}%`,
          maskImage,
          WebkitMaskImage: maskImage,
        }}
      >
        <Img
          src={staticFile(imagePath)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { SpeedPanSettings } from "../types";

export const SpeedPan: React.FC<{ imagePath: string; settings: SpeedPanSettings }> = ({
  imagePath,
  settings,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const src = staticFile(imagePath);

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = interpolate(progress, [0, 1], [settings.scaleFrom, settings.scaleTo]);
  const translateX = interpolate(progress, [0, 1], [settings.panXFrom, settings.panXTo]);

  const speed = Math.sin(progress * Math.PI);
  const blurPx = interpolate(speed, [0, 1], [0, 7]);
  const shake = Math.sin(frame * 1.7) * speed * 2.2;

  const opacity = interpolate(
    frame,
    [0, 12, durationInFrames - 12, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const ghostOffsets = [14, 8, 4];

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      {ghostOffsets.map((off, i) => (
        <AbsoluteFill
          key={i}
          style={{
            transform: `translate(${translateX}%, ${shake}px) translateX(${off * speed}px) scale(${scale})`,
            transformOrigin: "center center",
            opacity: 0.14 * speed,
            filter: `blur(${blurPx + 4}px)`,
          }}
        >
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </AbsoluteFill>
      ))}

      <AbsoluteFill
        style={{
          transform: `translate(${translateX}%, ${shake}px) scale(${scale})`,
          transformOrigin: "center center",
          filter: `blur(${blurPx}px)`,
        }}
      >
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background:
            "linear-gradient(90deg, rgba(0,0,0,0.35), transparent 20%, transparent 80%, rgba(0,0,0,0.35))",
        }}
      />
    </AbsoluteFill>
  );
};

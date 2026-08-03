import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig, Easing } from "remotion";
import type { FocusPullSettings } from "../types";

// Depth-of-field rack focus without needing subject/background segmentation:
// a blurred full-frame copy sits underneath a sharp copy that's clipped to a
// soft-edged circle over the subject. Animating the circle's radius and the
// blur amount reads as the camera racking focus onto the subject, using only
// two duplicate <Img> layers and a CSS mask — no cutout required.
export const FocusPull: React.FC<{ imagePath: string; settings: FocusPullSettings }> = ({
  imagePath,
  settings,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const diagonal = Math.sqrt(width * width + height * height);
  const src = staticFile(imagePath);

  const progress = interpolate(frame, [0, durationInFrames], [0, 1], {
    easing: Easing.inOut(Easing.ease),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scale = interpolate(progress, [0, 1], [settings.scaleFrom, settings.scaleTo]);
  const backgroundBlur = interpolate(progress, [0, 1], [settings.startBlurPx, settings.endBlurPx]);
  // Sharp circle grows in slightly slower than the rack-focus blur settles,
  // so the "click" of focus lands a beat after the blur has mostly resolved.
  const radiusProgress = interpolate(progress, [0.15, 0.85], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const radiusPx = interpolate(radiusProgress, [0, 1], [0, settings.maskRadius * diagonal]);

  const opacity = interpolate(
    frame,
    [0, 14, durationInFrames - 14, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const originX = settings.transformOriginX;
  const originY = settings.transformOriginY;
  const maskImage = `radial-gradient(circle ${radiusPx}px at ${originX}% ${originY}%, black 65%, transparent 100%)`;

  return (
    <AbsoluteFill style={{ backgroundColor: "black", opacity }}>
      <AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${originX}% ${originY}%` }}>
        <Img
          src={src}
          style={{ width: "100%", height: "100%", objectFit: "cover", filter: `blur(${backgroundBlur}px)` }}
        />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `scale(${scale})`,
          transformOrigin: `${originX}% ${originY}%`,
          maskImage,
          WebkitMaskImage: maskImage,
        }}
      >
        <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ boxShadow: "inset 0 0 160px 50px rgba(0,0,0,0.4)" }} />
    </AbsoluteFill>
  );
};

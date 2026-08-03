import React from "react";
import { Composition } from "remotion";
import { MotionClip } from "./MotionClip";
import { DEFAULT_PROPS, type MotionClipProps } from "./types";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MotionClip"
      component={MotionClip}
      // Real duration/fps/resolution come from --props at render time (each
      // clip on a timeline has its own length and the export's own target
      // resolution) — calculateMetadata reads them back out of the same
      // props object instead of this needing a fixed composition per clip.
      calculateMetadata={async ({ props }) => ({
        durationInFrames: props.durationInFrames,
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
      durationInFrames={DEFAULT_PROPS.durationInFrames}
      fps={DEFAULT_PROPS.fps}
      width={DEFAULT_PROPS.width}
      height={DEFAULT_PROPS.height}
      defaultProps={DEFAULT_PROPS}
    />
  );
};

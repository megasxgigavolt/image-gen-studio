import React from "react";
import type { MotionClipProps } from "./types";
import { KenBurns } from "./effects/KenBurns";
import { SequentialPanelReveal } from "./effects/SequentialPanelReveal";
import { SpeedPan } from "./effects/SpeedPan";
import { OminousPushIn } from "./effects/OminousPushIn";
import { CandleFlicker } from "./effects/CandleFlicker";
import { FocusPull } from "./effects/FocusPull";
import { IrisReveal } from "./effects/IrisReveal";

// Single dispatch point: one <Composition> (see Root.tsx) renders whichever
// of the 7 catalog effects this clip was assigned, parameterized entirely by
// `settings` — the same shape the AI selection pass (or a manual override in
// the desktop app) already produces. Adding an 8th effect means adding one
// component + one case here + the settings type in types.ts; nothing else in
// this service needs to change.
export const MotionClip: React.FC<MotionClipProps> = ({ imagePath, effect, settings }) => {
  switch (effect) {
    case "Ken Burns":
      return <KenBurns imagePath={imagePath} settings={settings as any} />;
    case "Sequential Panel Reveal":
      return <SequentialPanelReveal imagePath={imagePath} settings={settings as any} />;
    case "Speed Pan & Motion Blur":
      return <SpeedPan imagePath={imagePath} settings={settings as any} />;
    case "Ominous Push-In":
      return <OminousPushIn imagePath={imagePath} settings={settings as any} />;
    case "Candlelight Flicker":
      return <CandleFlicker imagePath={imagePath} settings={settings as any} />;
    case "Focus Pull":
      return <FocusPull imagePath={imagePath} settings={settings as any} />;
    case "Iris Reveal":
      return <IrisReveal imagePath={imagePath} settings={settings as any} />;
    default:
      // Unknown effect string (e.g. a future addition the running engine
      // version doesn't know about yet): fail safe to a neutral Ken Burns
      // rather than a black frame.
      return (
        <KenBurns
          imagePath={imagePath}
          settings={{ scaleFrom: 1.08, scaleTo: 1.22, panX: -3, panY: 2 }}
        />
      );
  }
};

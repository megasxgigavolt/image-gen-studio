import { useState } from "react";
import type { ColorFilterPreset, TimelineClipRecord } from "../../infrastructure/projects-client";

const PRESETS: ColorFilterPreset[] = ["none", "warm", "cool", "cinematic", "bright", "muted", "dark"];

/** State 4 tool panel for the Filters/Color toolbar icon. Operates on
 * whichever Stills clip is currently under the playhead (`selectedClip`),
 * same as the Camera-movement section in the Clip inspector — "Apply to"
 * decides whether a preset/intensity change lands on just that clip or
 * every still. */
export function FiltersTool({
  selectedClip,
  onSetColorFilter,
  onApplyColorFilterToAll,
}: {
  selectedClip: TimelineClipRecord | null;
  onSetColorFilter: (preset: ColorFilterPreset, intensity: number) => void;
  onApplyColorFilterToAll: (preset: ColorFilterPreset, intensity: number) => void;
}) {
  const [applyTo, setApplyTo] = useState<"clip" | "all">("clip");

  if (!selectedClip) {
    return (
      <div className="tl-inspector">
        <div className="tl-inspector-empty">
          <p className="tl-source-hint">Select a still on the timeline to apply a color filter.</p>
        </div>
      </div>
    );
  }

  function commit(preset: ColorFilterPreset, intensity: number) {
    if (applyTo === "all") onApplyColorFilterToAll(preset, intensity);
    else onSetColorFilter(preset, intensity);
  }

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Apply to</span>
        <div className="tl-preset-grid two">
          <button className={applyTo === "clip" ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setApplyTo("clip")}><span>This clip</span></button>
          <button className={applyTo === "all" ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setApplyTo("all")}><span>All clips</span></button>
        </div>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Filter presets</span>
        <div className="tl-preset-grid two">
          {PRESETS.map((preset) => (
            <button
              key={preset}
              className={selectedClip.colorFilterPreset === preset ? "tl-preset-btn active" : "tl-preset-btn"}
              onClick={() => commit(preset, selectedClip.colorFilterIntensity)}
            >
              <span style={{ textTransform: "capitalize" }}>{preset}</span>
            </button>
          ))}
        </div>
      </div>
      {selectedClip.colorFilterPreset !== "none" && (
        <div className="tl-inspector-group">
          <span className="tl-inspector-label">Intensity</span>
          <div className="tl-intensity-control">
            <input
              type="range" className="tl-slider" min={0} max={100} step={1}
              value={selectedClip.colorFilterIntensity}
              onChange={(event) => commit(selectedClip.colorFilterPreset, Number(event.target.value))}
            />
            <span className="tl-intensity-value">{Math.round(selectedClip.colorFilterIntensity)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

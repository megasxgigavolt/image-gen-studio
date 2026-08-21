import { useState } from "react";
import { Clapperboard, ChevronDown, LoaderCircle, Move, Music, Play, Trash2, X, ZoomIn } from "lucide-react";
import { ContextMenu } from "./ContextMenu";

export type ToolKind = "text" | "captions" | "music" | "motion";
export type AspectRatio = "16:9" | "9:16";

/** Slim icon toolbar between the preview and the timeline. Clicking a tool
 * icon activates it (driving State 4 of the contextual right panel) without
 * covering the preview. Also carries the two bulk actions relocated here
 * from the old "Global" inspector tab — they act on the whole timeline, not
 * a specific tool, but belong near the timeline they affect. */
export function Toolbar({
  activeTool,
  onSelectTool,
  onExtrapolateStills,
  extrapolating,
  hasSelectedClip,
  onRemoveThisClipEffects,
  onRemoveAllEffects,
  onAnalyzeMotionGraphics,
  onStopAutoMotion,
  analyzingMotionGraphics,
  motionGraphicsPaused,
  motionGraphicsProgressLabel,
  aspectRatio,
  onAspectRatioChange,
}: {
  activeTool: ToolKind | null;
  onSelectTool: (tool: ToolKind | null) => void;
  onExtrapolateStills: () => void;
  extrapolating: boolean;
  /** Gates the "this still only" option below — nothing is selected to
   * apply it to otherwise. */
  hasSelectedClip: boolean;
  onRemoveThisClipEffects: () => void;
  onRemoveAllEffects: () => void;
  /** A single control whose action depends on current state — idle: start;
   * running: pause; paused: resume. See TimelineView's `toggleAutoMotion`. */
  onAnalyzeMotionGraphics: () => void;
  /** Only enabled (and only shown) while paused — a full run in progress is
   * interrupted by pausing it first, not stopped outright. */
  onStopAutoMotion: () => void;
  analyzingMotionGraphics: boolean;
  motionGraphicsPaused: boolean;
  motionGraphicsProgressLabel: string | null;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
}) {
  const [removeMenuAnchor, setRemoveMenuAnchor] = useState<{ x: number; y: number } | null>(null);

  function toggle(tool: ToolKind) {
    onSelectTool(activeTool === tool ? null : tool);
  }

  return (
    <div className="tl-tool-toolbar">
      <div className="tl-tool-toolbar-group">
        <button className={activeTool === "captions" ? "tl-tool-btn active" : "tl-tool-btn"} title="Captions" onClick={() => toggle("captions")}>
          <span className="tl-tool-icon-glyph">≋</span><span>Captions</span>
        </button>
        <button className={activeTool === "music" ? "tl-tool-btn active" : "tl-tool-btn"} title="Audio" onClick={() => toggle("music")}>
          <Music size={16} /><span>Audio</span>
        </button>
        <button className={activeTool === "motion" ? "tl-tool-btn active" : "tl-tool-btn"} title="Motion" onClick={() => toggle("motion")}>
          <ZoomIn size={16} /><span>Motion</span>
        </button>
        <div className="tl-aspect-toggle" role="group" aria-label="Aspect ratio">
          <button
            className={aspectRatio === "16:9" ? "tl-aspect-btn active" : "tl-aspect-btn"}
            title="16:9 (landscape)"
            onClick={() => onAspectRatioChange("16:9")}
          >
            16:9
          </button>
          <button
            className={aspectRatio === "9:16" ? "tl-aspect-btn active" : "tl-aspect-btn"}
            title="9:16 (vertical)"
            onClick={() => onAspectRatioChange("9:16")}
          >
            9:16
          </button>
        </div>
      </div>
      <div className="tl-tool-toolbar-group">
        <button className="tl-tool-btn" disabled={extrapolating} title="Stretch every still to close gaps between them, so transitions become visible" onClick={onExtrapolateStills}>
          {extrapolating ? <LoaderCircle className="spin" size={16} /> : <Move size={16} />}<span>Fill gaps</span>
        </button>
        <button
          className="tl-tool-btn"
          title={motionGraphicsPaused ? "Resume auto motion" : analyzingMotionGraphics ? "Pause auto motion" : "Automatically analyzes every still and applies the best-fitting motion graphic to each, individually — pausable/resumable at any point"}
          onClick={onAnalyzeMotionGraphics}
        >
          {analyzingMotionGraphics && !motionGraphicsPaused ? <LoaderCircle className="spin" size={16} /> : motionGraphicsPaused ? <Play size={16} /> : <Clapperboard size={16} />}
          <span>{motionGraphicsProgressLabel ?? "Auto motion"}</span>
        </button>
        {motionGraphicsPaused && (
          <button className="tl-tool-btn danger" title="Stop — keep what's already been analyzed, discard the rest of this run" onClick={onStopAutoMotion}>
            <X size={16} />
          </button>
        )}
        <button
          className="tl-tool-btn danger"
          title="Remove camera movement, transitions, and gap-filling stretch"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setRemoveMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <Trash2 size={16} /><span>Remove effects</span><ChevronDown size={14} />
        </button>
        {removeMenuAnchor && (
          <ContextMenu
            x={removeMenuAnchor.x}
            y={removeMenuAnchor.y}
            onClose={() => setRemoveMenuAnchor(null)}
            items={[
              {
                label: "Remove effects from this still",
                disabled: !hasSelectedClip,
                onSelect: onRemoveThisClipEffects,
              },
              {
                label: "Remove all effects",
                danger: true,
                onSelect: onRemoveAllEffects,
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

import { Clapperboard, Hexagon, LoaderCircle, Move, Music, SlidersHorizontal, Trash2 } from "lucide-react";

export type ToolKind = "text" | "captions" | "music" | "filters" | "logo";
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
  onRemoveAllEffects,
  onAnalyzeMotionGraphics,
  analyzingMotionGraphics,
  motionGraphicsProgressLabel,
  aspectRatio,
  onAspectRatioChange,
}: {
  activeTool: ToolKind | null;
  onSelectTool: (tool: ToolKind | null) => void;
  onExtrapolateStills: () => void;
  extrapolating: boolean;
  onRemoveAllEffects: () => void;
  onAnalyzeMotionGraphics: () => void;
  analyzingMotionGraphics: boolean;
  motionGraphicsProgressLabel: string | null;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
}) {
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
        <button className={activeTool === "filters" ? "tl-tool-btn active" : "tl-tool-btn"} title="Filters / Color" onClick={() => toggle("filters")}>
          <SlidersHorizontal size={16} /><span>Filters</span>
        </button>
        <button className={activeTool === "logo" ? "tl-tool-btn active" : "tl-tool-btn"} title="Logo / Watermark" onClick={() => toggle("logo")}>
          <Hexagon size={16} /><span>Logo</span>
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
        <button className="tl-tool-btn" disabled={analyzingMotionGraphics} title="Automatically analyzes every still and applies the best-fitting motion graphic to each, individually" onClick={onAnalyzeMotionGraphics}>
          {analyzingMotionGraphics ? <LoaderCircle className="spin" size={16} /> : <Clapperboard size={16} />}
          <span>{analyzingMotionGraphics && motionGraphicsProgressLabel ? motionGraphicsProgressLabel : "Auto motion"}</span>
        </button>
        <button className="tl-tool-btn danger" title="Remove camera movement, transitions, and gap-filling stretch from every still" onClick={onRemoveAllEffects}>
          <Trash2 size={16} /><span>Remove all effects</span>
        </button>
      </div>
    </div>
  );
}

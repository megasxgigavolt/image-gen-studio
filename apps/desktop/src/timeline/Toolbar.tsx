import { Clapperboard, Hexagon, LoaderCircle, MoreHorizontal, Move, Music, SlidersHorizontal, Trash2, Type } from "lucide-react";

export type ToolKind = "text" | "captions" | "music" | "filters" | "logo";

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
}: {
  activeTool: ToolKind | null;
  onSelectTool: (tool: ToolKind | null) => void;
  onExtrapolateStills: () => void;
  extrapolating: boolean;
  onRemoveAllEffects: () => void;
  onAnalyzeMotionGraphics: () => void;
  analyzingMotionGraphics: boolean;
  motionGraphicsProgressLabel: string | null;
}) {
  function toggle(tool: ToolKind) {
    onSelectTool(activeTool === tool ? null : tool);
  }

  return (
    <div className="tl-tool-toolbar">
      <div className="tl-tool-toolbar-group">
        <button className={activeTool === "text" ? "tl-tool-btn active" : "tl-tool-btn"} title="Text overlay" onClick={() => toggle("text")}>
          <Type size={16} /><span>Text</span>
        </button>
        <button className={activeTool === "captions" ? "tl-tool-btn active" : "tl-tool-btn"} title="Captions" onClick={() => toggle("captions")}>
          <span className="tl-tool-icon-glyph">≋</span><span>Captions</span>
        </button>
        <button className={activeTool === "music" ? "tl-tool-btn active" : "tl-tool-btn"} title="Music" onClick={() => toggle("music")}>
          <Music size={16} /><span>Music</span>
        </button>
        <button className={activeTool === "filters" ? "tl-tool-btn active" : "tl-tool-btn"} title="Filters / Color" onClick={() => toggle("filters")}>
          <SlidersHorizontal size={16} /><span>Filters</span>
        </button>
        <button className={activeTool === "logo" ? "tl-tool-btn active" : "tl-tool-btn"} title="Logo / Watermark" onClick={() => toggle("logo")}>
          <Hexagon size={16} /><span>Logo</span>
        </button>
        <button className="tl-tool-btn" title="More tools coming soon" disabled>
          <MoreHorizontal size={16} /><span>More</span>
        </button>
      </div>
      <div className="tl-tool-toolbar-group">
        <button className="tl-tool-btn" disabled={extrapolating} title="Stretch every still to close gaps between them, so transitions become visible" onClick={onExtrapolateStills}>
          {extrapolating ? <LoaderCircle className="spin" size={16} /> : <Move size={16} />}<span>Fill gaps</span>
        </button>
        <button className="tl-tool-btn" disabled={analyzingMotionGraphics} title="Use OpenAI to pick a camera-movement treatment for every still, per the Motion Graphics SOP" onClick={onAnalyzeMotionGraphics}>
          {analyzingMotionGraphics ? <LoaderCircle className="spin" size={16} /> : <Clapperboard size={16} />}
          <span>{analyzingMotionGraphics && motionGraphicsProgressLabel ? motionGraphicsProgressLabel : "Motion Graphics"}</span>
        </button>
        <button className="tl-tool-btn danger" title="Remove camera movement, transitions, and gap-filling stretch from every still" onClick={onRemoveAllEffects}>
          <Trash2 size={16} /><span>Remove all effects</span>
        </button>
      </div>
    </div>
  );
}

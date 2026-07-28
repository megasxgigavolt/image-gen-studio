import { Download, LoaderCircle, Plus, Type } from "lucide-react";
import type { CaptionSetRecord, CaptionStyle } from "../infrastructure/projects-client";
import { CaptionStyleEditor } from "./CaptionStyleEditor";
import { resolveCaptionStyle } from "./timeline-rendering";

/** The captions tool's "nothing selected" state: generate/save/add-at-
 * playhead actions, plus the global default caption style that every
 * caption inherits unless it has its own per-clip override (set in
 * `CaptionsInspector`). Kept as its own component so the global-vs-per-clip
 * distinction has a clear home instead of living as an else-branch. */
export function GlobalTimelineSettings({
  captionSet,
  generatingCaptions,
  onGenerateCaptions,
  onSaveCaptionsAs,
  onAddCaptionAtPlayhead,
  effectiveGlobalCaptionStyle,
  onGlobalStyleChange,
  onResetGlobalStyle,
}: {
  captionSet: CaptionSetRecord | null;
  generatingCaptions: boolean;
  onGenerateCaptions: () => void;
  onSaveCaptionsAs: () => void;
  onAddCaptionAtPlayhead: () => void;
  effectiveGlobalCaptionStyle: CaptionStyle;
  onGlobalStyleChange: (patch: Partial<CaptionStyle>) => void;
  onResetGlobalStyle: () => void;
}) {
  const hasCaptions = Boolean(captionSet);
  return (
    <>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Generate</span>
        {!hasCaptions && <p className="tl-source-hint">No captions yet — generate them from the narration audio.</p>}
        <button className="secondary full" disabled={generatingCaptions} onClick={onGenerateCaptions}>
          {generatingCaptions ? <><LoaderCircle className="spin" size={16} />Generating…</> : <><Type size={16} />{hasCaptions ? "Regenerate captions" : "Generate captions"}</>}
        </button>
        <button className="secondary full" disabled={!hasCaptions} onClick={onSaveCaptionsAs}><Download size={16} />Save captions as…</button>
      </div>
      <div className="tl-inspector-group">
        <button className="secondary full" onClick={onAddCaptionAtPlayhead}><Plus size={14} />Add caption at playhead</button>
        <p className="tl-source-hint">Select a caption on the lane below to edit, retime, split, merge, or style it individually.</p>
      </div>
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label">Global default style</span>
          <button className="tl-apply-all-btn" onClick={onResetGlobalStyle}>Reset to default</button>
        </div>
        <p className="tl-source-hint">Applies to every caption that hasn't been given its own style override.</p>
        <CaptionStyleEditor
          style={resolveCaptionStyle(effectiveGlobalCaptionStyle, null)}
          onChange={onGlobalStyleChange}
        />
      </div>
    </>
  );
}

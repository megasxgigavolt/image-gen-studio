import { ChevronLeft, ChevronRight, Scissors, Trash2, Type } from "lucide-react";
import { formatTime } from "../domain/timecode";
import type { CaptionSetRecord, CaptionStyle, TimelineCaptionClipRecord } from "../infrastructure/projects-client";
import { CaptionStyleEditor } from "./CaptionStyleEditor";
import { resolveCaptionStyle } from "./timeline-rendering";
import { GlobalTimelineSettings } from "./GlobalTimelineSettings";

/** The Captions tool panel: editing the selected caption (text, timing,
 * split/merge/delete, prev/next navigation, per-caption style override), or
 * — when nothing is selected — `GlobalTimelineSettings`'s generate/global-
 * style view. */
export function CaptionsInspector({
  selectedCaptionClip,
  captionClips,
  captionText,
  onCaptionTextChange,
  onCommitCaptionText,
  previewTime,
  onSplitAtPlayhead,
  onMergeWithNext,
  onDeleteCaption,
  onBack,
  onSelectCaption,
  effectiveSelectedCaptionStyle,
  effectiveGlobalCaptionStyle,
  onSelectedStyleChange,
  onResetSelectedStyle,
  captionSet,
  generatingCaptions,
  onGenerateCaptions,
  onSaveCaptionsAs,
  onAddCaptionAtPlayhead,
  onGlobalStyleChange,
  onResetGlobalStyle,
}: {
  selectedCaptionClip: TimelineCaptionClipRecord | null;
  captionClips: TimelineCaptionClipRecord[];
  captionText: string;
  onCaptionTextChange: (value: string) => void;
  onCommitCaptionText: () => void;
  previewTime: number;
  onSplitAtPlayhead: () => void;
  onMergeWithNext: () => void;
  onDeleteCaption: () => void;
  onBack: () => void;
  onSelectCaption: (clip: TimelineCaptionClipRecord) => void;
  effectiveSelectedCaptionStyle: CaptionStyle | null;
  effectiveGlobalCaptionStyle: CaptionStyle;
  onSelectedStyleChange: (patch: Partial<CaptionStyle>) => void;
  onResetSelectedStyle: () => void;
  captionSet: CaptionSetRecord | null;
  generatingCaptions: boolean;
  onGenerateCaptions: () => void;
  onSaveCaptionsAs: () => void;
  onAddCaptionAtPlayhead: () => void;
  onGlobalStyleChange: (patch: Partial<CaptionStyle>) => void;
  onResetGlobalStyle: () => void;
}) {
  if (!selectedCaptionClip) {
    return (
      <div className="tl-inspector">
        <GlobalTimelineSettings
          captionSet={captionSet}
          generatingCaptions={generatingCaptions}
          onGenerateCaptions={onGenerateCaptions}
          onSaveCaptionsAs={onSaveCaptionsAs}
          onAddCaptionAtPlayhead={onAddCaptionAtPlayhead}
          effectiveGlobalCaptionStyle={effectiveGlobalCaptionStyle}
          onGlobalStyleChange={onGlobalStyleChange}
          onResetGlobalStyle={onResetGlobalStyle}
        />
      </div>
    );
  }

  const index = captionClips.findIndex((clip) => clip.id === selectedCaptionClip.id);
  const previousClip = index > 0 ? captionClips[index - 1] : null;
  const nextClip = index >= 0 && index < captionClips.length - 1 ? captionClips[index + 1] : null;
  const canMergeWithNext = captionClips.some((clip) => Math.abs(clip.startSeconds - selectedCaptionClip.endSeconds) < 0.01);
  const duration = selectedCaptionClip.endSeconds - selectedCaptionClip.startSeconds;

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-header">
        <button className="tl-apply-all-btn" style={{ alignSelf: "flex-start" }} onClick={onBack}>← Back</button>
        <strong><Type size={14} />Caption</strong>
        <span>{formatTime(selectedCaptionClip.startSeconds)} – {formatTime(selectedCaptionClip.endSeconds)} <i>({duration.toFixed(1)}s)</i></span>
        <div className="tl-caption-nav">
          <button className="tl-icon-btn" title="Previous caption" disabled={!previousClip} onClick={() => previousClip && onSelectCaption(previousClip)}><ChevronLeft size={14} /></button>
          <span>{index + 1} / {captionClips.length}</span>
          <button className="tl-icon-btn" title="Next caption" disabled={!nextClip} onClick={() => nextClip && onSelectCaption(nextClip)}><ChevronRight size={14} /></button>
        </div>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Text</span>
        <textarea
          className="tl-prompt-textarea"
          rows={3}
          value={captionText}
          onChange={(event) => onCaptionTextChange(event.target.value)}
          onBlur={onCommitCaptionText}
        />
        <div className="tl-preset-grid two">
          <button
            className="secondary"
            disabled={previewTime <= selectedCaptionClip.startSeconds || previewTime >= selectedCaptionClip.endSeconds}
            onClick={onSplitAtPlayhead}
          >
            <Scissors size={14} />Split at playhead
          </button>
          <button className="secondary" disabled={!canMergeWithNext} onClick={onMergeWithNext}>
            Merge with next
          </button>
        </div>
        <button className="secondary danger-action" onClick={onDeleteCaption}><Trash2 size={14} />Delete caption</button>
      </div>
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label">Style override</span>
          {effectiveSelectedCaptionStyle && (
            <button className="tl-apply-all-btn" onClick={onResetSelectedStyle}>Reset to default</button>
          )}
        </div>
        {!effectiveSelectedCaptionStyle && <p className="tl-source-hint">Inheriting the global default — adjust anything below to customize just this caption.</p>}
        {selectedCaptionClip.words?.length ? (
          <p className="tl-source-hint tl-word-highlight-hint available">Word highlight available — this caption has per-word timing.</p>
        ) : (
          <p className="tl-source-hint">
            No original narration timing on this caption (it was hand-edited or added manually) — word
            highlight won't apply here even if turned on; the whole caption stays one color.
          </p>
        )}
        <CaptionStyleEditor
          style={resolveCaptionStyle(effectiveGlobalCaptionStyle, effectiveSelectedCaptionStyle)}
          onChange={onSelectedStyleChange}
        />
      </div>
    </div>
  );
}

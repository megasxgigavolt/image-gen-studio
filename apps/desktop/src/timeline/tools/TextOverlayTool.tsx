import { useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  projectsClient,
  type TextBackgroundMode,
  type TextOverlayAnimation,
  type TextOverlayPosition,
  type TimelineRecord,
  type TimelineTextClipRecord,
} from "../../infrastructure/projects-client";

const POSITIONS: TextOverlayPosition[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];
const FONT_OPTIONS = ["Rubik", "Arial Black", "Arial", "Impact", "Verdana", "Georgia", "Courier New"];

/** State 4 tool panel for the Text overlay toolbar icon. Selecting an
 * existing overlay clip on the Overlays lane loads it here for editing
 * (mirrors how selecting a caption clip activates the Captions tool). */
export function TextOverlayTool({
  videoId,
  timeline,
  selectedTextClip,
  playheadSeconds,
  onSelectClip,
  refresh,
  addToast,
  focusRequestId,
}: {
  videoId: string;
  timeline: TimelineRecord;
  selectedTextClip: TimelineTextClipRecord | null;
  playheadSeconds: number;
  onSelectClip: (clip: TimelineTextClipRecord | null) => void;
  refresh: (promise: Promise<TimelineRecord>) => Promise<void>;
  addToast: (message: string, kind?: "success" | "error" | "info") => void;
  /** Bumped by the Overlays lane's double-click handler — there's no
   * canvas rendering of text overlays to click into directly, so
   * double-clicking the timeline clip instead jumps straight into this
   * panel's text field, focused and ready to type. */
  focusRequestId?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusRequestId) { textareaRef.current?.focus(); textareaRef.current?.select(); }
  }, [focusRequestId]);
  async function addNew() {
    try {
      const previousIds = new Set(timeline.textClips.map((clip) => clip.id));
      const next = await projectsClient.addTextOverlayClip(videoId, playheadSeconds);
      await refresh(Promise.resolve(next));
      const created = next.textClips.find((clip) => !previousIds.has(clip.id));
      if (created) onSelectClip(created);
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  async function remove() {
    if (!selectedTextClip) return;
    try {
      await refresh(projectsClient.deleteTextOverlayClip(videoId, selectedTextClip.id));
      onSelectClip(null);
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  function update(patch: Partial<{
    text: string; fontFamily: string; fontSizePx: number; bold: boolean; italic: boolean; color: string;
    backgroundMode: TextBackgroundMode; backgroundColor: string; position: TextOverlayPosition; animation: TextOverlayAnimation;
  }>) {
    if (!selectedTextClip) return;
    void refresh(projectsClient.setTextOverlayStyle(
      videoId, selectedTextClip.id,
      patch.text ?? selectedTextClip.text,
      patch.fontFamily ?? selectedTextClip.fontFamily,
      patch.fontSizePx ?? selectedTextClip.fontSizePx,
      patch.bold ?? selectedTextClip.bold,
      patch.italic ?? selectedTextClip.italic,
      patch.color ?? selectedTextClip.color,
      patch.backgroundMode ?? selectedTextClip.backgroundMode,
      patch.backgroundColor ?? selectedTextClip.backgroundColor,
      patch.position ?? selectedTextClip.position,
      patch.animation ?? selectedTextClip.animation,
    ));
  }

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <button className="secondary full" onClick={() => void addNew()}><Plus size={14} />Add text overlay at playhead</button>
        <p className="tl-source-hint">Select an overlay on the Overlays track below to edit it, or add a new one here.</p>
      </div>
      {selectedTextClip && (
        <>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Text</span>
            <textarea
              ref={textareaRef}
              className="tl-prompt-textarea"
              rows={2}
              value={selectedTextClip.text}
              onChange={(event) => update({ text: event.target.value })}
            />
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Font</span>
            <select className="tl-select" value={selectedTextClip.fontFamily} onChange={(event) => update({ fontFamily: event.target.value })}>
              {FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
            </select>
            <div className="tl-intensity-control">
              <input type="range" className="tl-slider" min={12} max={96} step={1} value={selectedTextClip.fontSizePx} onChange={(event) => update({ fontSizePx: Number(event.target.value) })} />
              <span className="tl-intensity-value">{Math.round(selectedTextClip.fontSizePx)}px</span>
            </div>
            <div className="tl-preset-grid two">
              <button className={selectedTextClip.bold ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => update({ bold: !selectedTextClip.bold })}><span>Bold</span></button>
              <button className={selectedTextClip.italic ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => update({ italic: !selectedTextClip.italic })}><span>Italic</span></button>
            </div>
            <label className="tl-color-row"><span>Color</span><input type="color" value={selectedTextClip.color} onChange={(event) => update({ color: event.target.value })} /></label>
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Background</span>
            <div className="tl-preset-grid three">
              {(["none", "solid", "blur"] as TextBackgroundMode[]).map((mode) => (
                <button key={mode} className={selectedTextClip.backgroundMode === mode ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => update({ backgroundMode: mode })}>
                  <span>{mode}</span>
                </button>
              ))}
            </div>
            {selectedTextClip.backgroundMode === "solid" && (
              <label className="tl-color-row"><span>Background color</span><input type="color" value={selectedTextClip.backgroundColor} onChange={(event) => update({ backgroundColor: event.target.value })} /></label>
            )}
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Position</span>
            <div className="tl-position-grid full">
              {POSITIONS.map((position) => (
                <button key={position} className={selectedTextClip.position === position ? "tl-position-cell active" : "tl-position-cell"} data-position={position} title={position} onClick={() => update({ position })} />
              ))}
            </div>
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Animation</span>
            <div className="tl-preset-grid three">
              {(["none", "fade", "slide"] as TextOverlayAnimation[]).map((animation) => (
                <button key={animation} className={selectedTextClip.animation === animation ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => update({ animation })}>
                  <span>{animation}</span>
                </button>
              ))}
            </div>
            <p className="tl-source-hint">Duration is set by dragging this overlay's edges on the Overlays track.</p>
          </div>
          <div className="tl-inspector-actions">
            <button className="secondary danger-action" onClick={() => void remove()}><Trash2 size={14} />Delete overlay</button>
          </div>
        </>
      )}
    </div>
  );
}

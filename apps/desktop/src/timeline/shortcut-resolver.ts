/** Pure classification for the Editor's keyboard shortcuts — kept separate
 * from TimelineView's keydown handler (which has to reach into a dozen
 * pieces of component state to actually execute an action) so the mapping
 * itself is unit-testable without rendering the whole Editor. */

export type ShortcutAction =
  | { type: "toggleHelp" }
  | { type: "closeTransient" }
  | { type: "togglePlay" }
  | { type: "seek"; direction: -1 | 1 }
  | { type: "jumpClip"; direction: -1 | 1 }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "forceSave" }
  | { type: "delete" };

type ShortcutEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
};

/** True when the given element is a text input the shortcut handler must
 * not intercept keystrokes from (matches ThumbnailEditor.tsx's guard). */
export function isTypingTarget(active: Element | null | undefined): boolean {
  return (
    active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active?.getAttribute("contenteditable") === "true"
  );
}

/** Maps a keydown event to the Editor action it represents, or `null` if
 * the key isn't one of the Editor's shortcuts. Does not consult
 * `isTypingTarget` itself — callers must check that first. */
export function resolveShortcutAction(event: ShortcutEvent): ShortcutAction | null {
  if (event.key === "?") return { type: "toggleHelp" };
  if (event.key === "Escape") return { type: "closeTransient" };
  if (event.key === " ") return { type: "togglePlay" };
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    return event.shiftKey ? { type: "jumpClip", direction } : { type: "seek", direction };
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    return event.shiftKey ? { type: "redo" } : { type: "undo" };
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    return { type: "forceSave" };
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    return { type: "delete" };
  }
  return null;
}

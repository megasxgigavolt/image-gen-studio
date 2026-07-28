import { describe, expect, it } from "vitest";
import { isTypingTarget, resolveShortcutAction } from "./shortcut-resolver";

function key(k: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...extra };
}

describe("resolveShortcutAction", () => {
  it("maps Space to togglePlay", () => {
    expect(resolveShortcutAction(key(" "))).toEqual({ type: "togglePlay" });
  });

  it("maps plain arrows to a frame seek in the matching direction", () => {
    expect(resolveShortcutAction(key("ArrowLeft"))).toEqual({ type: "seek", direction: -1 });
    expect(resolveShortcutAction(key("ArrowRight"))).toEqual({ type: "seek", direction: 1 });
  });

  it("maps Shift+arrows to jumping to the previous/next clip", () => {
    expect(resolveShortcutAction(key("ArrowLeft", { shiftKey: true }))).toEqual({ type: "jumpClip", direction: -1 });
    expect(resolveShortcutAction(key("ArrowRight", { shiftKey: true }))).toEqual({ type: "jumpClip", direction: 1 });
  });

  it("maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z to redo", () => {
    expect(resolveShortcutAction(key("z", { ctrlKey: true }))).toEqual({ type: "undo" });
    expect(resolveShortcutAction(key("z", { metaKey: true }))).toEqual({ type: "undo" });
    expect(resolveShortcutAction(key("z", { ctrlKey: true, shiftKey: true }))).toEqual({ type: "redo" });
  });

  it("maps Ctrl/Cmd+S to forceSave", () => {
    expect(resolveShortcutAction(key("s", { ctrlKey: true }))).toEqual({ type: "forceSave" });
  });

  it("maps Delete and Backspace to delete", () => {
    expect(resolveShortcutAction(key("Delete"))).toEqual({ type: "delete" });
    expect(resolveShortcutAction(key("Backspace"))).toEqual({ type: "delete" });
  });

  it("maps ? to toggleHelp and Escape to closeTransient", () => {
    expect(resolveShortcutAction(key("?"))).toEqual({ type: "toggleHelp" });
    expect(resolveShortcutAction(key("Escape"))).toEqual({ type: "closeTransient" });
  });

  it("returns null for keys with no shortcut, and for a bare 'z'/'s' without a modifier", () => {
    expect(resolveShortcutAction(key("a"))).toBeNull();
    expect(resolveShortcutAction(key("z"))).toBeNull();
    expect(resolveShortcutAction(key("s"))).toBeNull();
    expect(resolveShortcutAction(key("Enter"))).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("is true for input and textarea elements", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
  });

  it("is true for a contenteditable element", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    expect(isTypingTarget(div)).toBe(true);
  });

  it("is false for a plain element, and for null/undefined", () => {
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(document.createElement("div"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

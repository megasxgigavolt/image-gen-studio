import { vi } from "vitest";

// jsdom has no Tauri host — every screen that unconditionally calls a Tauri
// API at render/mount time (rather than gating on projectsClient's own
// isTauri() check) needs that API mocked here, or rendering it under
// vitest throws. Kept intentionally minimal: only what's actually called
// during a render/mount, not a full Tauri API surface.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    innerSize: vi.fn(() => Promise.resolve({ width: 1280, height: 800 })),
    scaleFactor: vi.fn(() => Promise.resolve(1)),
    onResized: vi.fn(() => Promise.resolve(() => {})),
  }),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setZoom: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

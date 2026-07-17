import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
// Caption styling defaults to "Rubik", which isn't a built-in OS font —
// self-host it so the canvas preview renders real Rubik glyphs regardless
// of what's installed on the machine (the burned-in export gets the same
// font via a bundled TTF passed to ffmpeg's ass filter, see
// video_export_engine.py).
import "@fontsource/rubik/400.css";
import "@fontsource/rubik/700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);

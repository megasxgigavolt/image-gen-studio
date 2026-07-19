import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
// Rubik is the app's primary UI font (and caption styling defaults to it too),
// and it isn't a built-in OS font — self-host it so both the UI chrome and the
// canvas preview render real Rubik glyphs regardless of what's installed on the
// machine (the burned-in export gets the same font via a bundled TTF passed to
// ffmpeg's ass filter, see video_export_engine.py).
import "@fontsource/rubik/400.css";
import "@fontsource/rubik/500.css";
import "@fontsource/rubik/600.css";
import "@fontsource/rubik/700.css";
import "@fontsource/rubik/800.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);

// Renders every motion-graphic clip for ONE export in a single Node process,
// bundling services/motion-engine and launching headless Chromium exactly
// once, then reusing both across every clip — instead of the old approach
// (still used as a fallback, see video_export_engine.py's _render_motion_graphic)
// of shelling out to `npx remotion render` separately per clip, which pays a
// full cold Node/webpack/Chromium startup (measured at ~30s on a real
// machine) for every single one. Invoked by video_export_engine.py's
// _batch_render_motion_graphics as:
//   node batch-render.mjs <batchSpecPath> <resultsPath> <publicDir>
//
// batchSpecPath: JSON array of
//   { id, mediaPath (relative to publicDir), sourceKind, recipe,
//     durationInFrames, motionDurationInFrames?, fps, width, height, outPath }
// resultsPath: where this script writes back a JSON array of
//   { id, ok, error? } — one entry per input item, always written even if
//   some items failed, mirroring this repo's existing
//   analyze_motion_graphics_batch / results_path convention elsewhere.
// publicDir: one directory `staticFile(mediaPath)` resolves every item's
//   mediaPath against — the longest common ancestor of every item's own
//   source folder, computed by the Python caller (see
//   `_common_public_dir` in video_export_engine.py).
import { bundle } from "@remotion/bundler";
import { openBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Chromium's own compositor is a real GPU rendering pipeline — the same
// mechanism CapCut/Clipchamp-style editors use for their own speed — but
// Remotion never asks for it by default (`DEFAULT_OPENGL_RENDERER` in
// @remotion/renderer is `null`, i.e. no explicit `--gl` override), which
// leaves Chromium to fall back to software rasterization (SwiftShader) for
// every render this module has ever done. "angle" is Remotion's own
// documented GPU-accelerated option (ANGLE translates Chromium's GL calls to
// the platform's native graphics API — Direct3D on Windows, this app's only
// shipped target); "swiftshader" is Remotion's documented pure-software
// renderer, used as the fallback for a machine with no usable GPU (an old
// machine, certain VMs/sandboxes, or a broken/missing driver) — tried in
// that order, once per export (this whole batch shares one browser launch),
// not per-clip: a GPU that can't open at all fails at THIS launch step, not
// partway through a specific clip's render.
async function openBrowserWithGpuFallback() {
  const candidates = ["angle", "swiftshader"];
  let lastError;
  for (const gl of candidates) {
    try {
      const browser = await openBrowser("chrome", { chromiumOptions: { gl } });
      return { browser, gl };
    } catch (error) {
      lastError = error;
      process.stderr.write(
        `Chromium failed to launch with --gl=${gl}: ${(error && error.message) || error}\n`,
      );
    }
  }
  throw lastError;
}

async function main() {
  const [, , batchPath, resultsPath, publicDir] = process.argv;
  if (!batchPath || !resultsPath || !publicDir) {
    throw new Error("Usage: node batch-render.mjs <batchSpecPath> <resultsPath> <publicDir>");
  }
  const items = JSON.parse(fs.readFileSync(batchPath, "utf-8"));
  const results = [];

  if (items.length === 0) {
    fs.writeFileSync(resultsPath, JSON.stringify(results));
    return;
  }

  const bundleLocation = await bundle({
    entryPoint: path.join(__dirname, "index.ts"),
    publicDir,
    onProgress: () => {},
  });

  const { browser, gl } = await openBrowserWithGpuFallback();
  process.stdout.write(`GL_RENDERER ${gl}\n`);
  try {
    // Renders run one at a time against the shared browser/bundle —
    // confirmed by direct testing that overlapping concurrent renderMedia()
    // calls against the SAME HeadlessBrowser instance race on which
    // composition's props each tab actually sees (props from one item
    // occasionally showed up as `undefined` inside another item's render).
    // This still eliminates the real, measured cost (the ~30s per-clip
    // cold Node/webpack/Chromium startup) — only the already-cheap
    // per-frame rendering (~3s/clip) stays serial, each clip's frames are
    // themselves still rendered with Remotion's own internal multi-tab
    // frame concurrency.
    for (const item of items) {
      const durationInFrames = Math.max(1, item.durationInFrames);
      const inputProps = {
        mediaPath: item.mediaPath,
        sourceKind: item.sourceKind,
        recipe: item.recipe,
        durationInFrames,
        // Only a join transition's tail window sets this (see
        // motionDurationInFrames in types.ts); omitted elsewhere so
        // MotionClip falls back to durationInFrames exactly as before.
        ...(item.motionDurationInFrames
          ? { motionDurationInFrames: Math.max(1, item.motionDurationInFrames) }
          : {}),
        fps: item.fps,
        width: item.width,
        height: item.height,
      };
      try {
        // Constructing the VideoConfig by hand (skipping this step) silently
        // drops inputProps — confirmed by direct testing (`staticFile()`
        // received `undefined` for `mediaPath`) — MotionClip's composition
        // uses `calculateMetadata`, and selectComposition is what actually
        // runs it against the real inputProps and returns the merged
        // result renderMedia needs; the CLI does this same step internally,
        // which is why it never hit this.
        const composition = await selectComposition({
          serveUrl: bundleLocation,
          id: "MotionClip",
          inputProps,
          puppeteerInstance: browser,
          logLevel: "error",
        });
        await renderMedia({
          composition,
          serveUrl: bundleLocation,
          codec: "h264",
          outputLocation: item.outPath,
          inputProps,
          puppeteerInstance: browser,
          muted: true,
          logLevel: "error",
        });
        results.push({ id: item.id, ok: true });
      } catch (error) {
        results.push({ id: item.id, ok: false, error: String((error && error.stack) || error) });
      }
      // One line per completed item, on its own — video_export_engine.py's
      // _batch_render_motion_graphics streams stdout and turns this into
      // export progress (5%-10% band) as each clip finishes, instead of the
      // whole batch reporting nothing until every item is done (which reads
      // as "stuck" on a timeline with several Tier 2/4/5 clips in a row).
      process.stdout.write(`PROGRESS ${results.length} ${items.length}\n`);
    }
  } finally {
    await browser.close({ silent: true });
  }

  fs.writeFileSync(resultsPath, JSON.stringify(results));
}

main().catch((error) => {
  console.error(String((error && error.stack) || error));
  process.exit(1);
});

import { useEffect, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { resolveMediaLibraryAssetUrl } from "../../infrastructure/media-cache";
import { projectsClient, type LogoPosition, type TimelineLogoClipRecord, type TimelineRecord } from "../../infrastructure/projects-client";

const POSITIONS: LogoPosition[] = ["top-left", "top-right", "center", "bottom-left", "bottom-right"];

/** State 4 tool panel for the Logo/Watermark toolbar icon. Only one logo
 * clip is supported through this panel (the first one on the Overlays
 * track) — matching the spec's singular "Logo / Watermark" tool. */
export function LogoTool({
  videoId,
  logoClip,
  refresh,
  addToast,
}: {
  videoId: string;
  logoClip: TimelineLogoClipRecord | null;
  refresh: (promise: Promise<TimelineRecord>) => Promise<void>;
  addToast: (message: string, kind?: "success" | "error" | "info") => void;
}) {
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    if (!logoClip) { setPreviewUrl(""); return; }
    let cancelled = false;
    void resolveMediaLibraryAssetUrl(logoClip.mediaLibraryAssetId).then((url) => { if (!cancelled) setPreviewUrl(url); });
    return () => { cancelled = true; };
  }, [logoClip?.mediaLibraryAssetId]);

  async function uploadLogo() {
    try {
      const asset = await projectsClient.pickAndImportMediaLibraryAsset(videoId, "still");
      if (!asset) return;
      if (logoClip) await projectsClient.deleteLogoClip(videoId, logoClip.id);
      await refresh(projectsClient.addLogoClip(videoId, asset.id));
      addToast("Logo/watermark added.", "success");
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  async function removeLogo() {
    if (!logoClip) return;
    await refresh(projectsClient.deleteLogoClip(videoId, logoClip.id));
  }

  function updateStyle(patch: Partial<{ position: LogoPosition; sizePercent: number; opacityPercent: number; showThroughout: boolean }>) {
    if (!logoClip) return;
    void refresh(projectsClient.setLogoClipStyle(
      videoId, logoClip.id,
      patch.position ?? logoClip.position,
      patch.sizePercent ?? logoClip.sizePercent,
      patch.opacityPercent ?? logoClip.opacityPercent,
      patch.showThroughout ?? logoClip.showThroughout,
    ));
  }

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Logo image</span>
        {previewUrl && <img className="tl-logo-preview" src={previewUrl} alt="Logo preview" />}
        <button className="secondary full" onClick={() => void uploadLogo()}><Upload size={14} />{logoClip ? "Replace logo image" : "Upload logo image"}</button>
        {logoClip && <button className="secondary danger-action full" onClick={() => void removeLogo()}><Trash2 size={14} />Remove logo</button>}
      </div>
      {logoClip && (
        <>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Position</span>
            <div className="tl-position-grid">
              {POSITIONS.map((position) => (
                <button
                  key={position}
                  className={logoClip.position === position ? "tl-position-cell active" : "tl-position-cell"}
                  data-position={position}
                  title={position}
                  onClick={() => updateStyle({ position })}
                />
              ))}
            </div>
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Size</span>
            <div className="tl-intensity-control">
              <input type="range" className="tl-slider" min={5} max={30} step={1} value={logoClip.sizePercent} onChange={(event) => updateStyle({ sizePercent: Number(event.target.value) })} />
              <span className="tl-intensity-value">{Math.round(logoClip.sizePercent)}%</span>
            </div>
          </div>
          <div className="tl-inspector-group">
            <span className="tl-inspector-label">Opacity</span>
            <div className="tl-intensity-control">
              <input type="range" className="tl-slider" min={0} max={100} step={1} value={logoClip.opacityPercent} onChange={(event) => updateStyle({ opacityPercent: Number(event.target.value) })} />
              <span className="tl-intensity-value">{Math.round(logoClip.opacityPercent)}%</span>
            </div>
          </div>
          <div className="tl-inspector-group">
            <label className="tl-checkbox-row">
              <input type="checkbox" checked={logoClip.showThroughout} onChange={(event) => updateStyle({ showThroughout: event.target.checked })} />
              <span>Show throughout video</span>
            </label>
            <p className="tl-source-hint">When on, the logo automatically spans the full video even if its length changes later.</p>
          </div>
        </>
      )}
    </div>
  );
}

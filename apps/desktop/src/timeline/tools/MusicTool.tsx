import { useEffect, useState } from "react";
import { Sparkles, Upload } from "lucide-react";
import { projectsClient, type MediaLibraryAssetRecord, type TimelineRecord } from "../../infrastructure/projects-client";

/** State 4 tool panel for the Music toolbar icon — importing music/SFX, the
 * master volume/duck-sensitivity that apply on top of each music clip's own
 * per-clip settings (edited via State 3 when a Music clip is selected), and
 * denoising an imported Audio-tab file (same non-destructive cleanup the
 * Media Library panel already offers per-asset — surfaced here too since
 * this is the panel someone tuning the music mix is already in). */
export function MusicTool({
  videoId,
  timeline,
  playheadSeconds,
  refresh,
  addToast,
}: {
  videoId: string;
  timeline: TimelineRecord;
  playheadSeconds: number;
  refresh: (promise: Promise<TimelineRecord>) => Promise<void>;
  addToast: (message: string, kind?: "success" | "error" | "info") => void;
}) {
  const [audioAssets, setAudioAssets] = useState<MediaLibraryAssetRecord[]>([]);
  const [denoisingId, setDenoisingId] = useState<string | null>(null);

  async function reloadAudioAssets() {
    try {
      setAudioAssets(await projectsClient.listMediaLibraryAssets(videoId, "audio"));
    } catch {
      // Leave whatever list is already showing.
    }
  }

  useEffect(() => {
    void reloadAudioAssets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  async function importMusic() {
    try {
      const asset = await projectsClient.pickAndImportMediaLibraryAsset(videoId, "audio");
      if (!asset) return;
      await refresh(projectsClient.addMusicClip(videoId, asset.id, playheadSeconds));
      addToast(`Added "${asset.originalName}" to the music track.`, "success");
      void reloadAudioAssets();
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  /** Cleans up hiss/hum/static in an Audio-tab file. Non-destructive — the
   * result lands as a new "(denoised)" asset next to the original, which is
   * left untouched (same behavior as the Media Library panel's own version
   * of this action). */
  async function denoiseAsset(asset: MediaLibraryAssetRecord) {
    if (denoisingId) return;
    setDenoisingId(asset.id);
    try {
      const result = await projectsClient.denoiseMediaLibraryAsset(asset.id);
      await reloadAudioAssets();
      addToast(`Removed background noise — added "${result.originalName}".`, "success");
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      setDenoisingId(null);
    }
  }

  function updateMaster(volume: number, duck: number) {
    void refresh(projectsClient.setMusicMasterSettings(videoId, volume, duck));
  }

  async function toggleAutoDuckForAll() {
    const nextValue = !timeline.musicClips.every((clip) => clip.autoDuck);
    for (const clip of timeline.musicClips) {
      await projectsClient.setMusicClipSettings(
        videoId, clip.id, clip.volumePercent,
        clip.fadeInEnabled, clip.fadeInSeconds, clip.fadeOutEnabled, clip.fadeOutSeconds,
        nextValue, clip.loopEnabled,
      );
    }
    await refresh(projectsClient.getTimeline(videoId));
  }

  const allAutoDuck = timeline.musicClips.length > 0 && timeline.musicClips.every((clip) => clip.autoDuck);

  return (
    <div className="tl-inspector">
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Import</span>
        <button className="secondary full" onClick={() => void importMusic()}><Upload size={14} />Import music file</button>
        <p className="tl-source-hint">Adds the file to the Audio tab of the media library and places it on the Music track at the playhead.</p>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Master volume</span>
        <div className="tl-intensity-control">
          <input
            type="range" className="tl-slider" min={0} max={200} step={1}
            value={timeline.musicMasterVolumePercent}
            onChange={(event) => updateMaster(Number(event.target.value), timeline.musicDuckSensitivityPercent)}
          />
          <span className="tl-intensity-value">{Math.round(timeline.musicMasterVolumePercent)}%</span>
        </div>
      </div>
      <div className="tl-inspector-group">
        <div className="tl-inspector-label-row">
          <span className="tl-inspector-label">Auto-duck</span>
          <button className="tl-apply-all-btn" disabled={!timeline.musicClips.length} onClick={() => void toggleAutoDuckForAll()}>
            {allAutoDuck ? "Disable for all clips" : "Enable for all clips"}
          </button>
        </div>
        <p className="tl-source-hint">Lowers music volume automatically for the entire span where narration audio is present.</p>
      </div>
      <div className="tl-inspector-group">
        <span className="tl-inspector-label">Duck sensitivity</span>
        <div className="tl-intensity-control">
          <input
            type="range" className="tl-slider" min={0} max={100} step={1}
            value={timeline.musicDuckSensitivityPercent}
            onChange={(event) => updateMaster(timeline.musicMasterVolumePercent, Number(event.target.value))}
          />
          <span className="tl-intensity-value">{Math.round(timeline.musicDuckSensitivityPercent)}%</span>
        </div>
        <p className="tl-source-hint">How much quieter music gets under narration once auto-duck is enabled.</p>
      </div>
      {audioAssets.length > 0 && (
        <div className="tl-inspector-group">
          <span className="tl-inspector-label">Denoise</span>
          <p className="tl-source-hint">Removes background hiss/hum/static from an imported file — the cleaned result is added as a new file, the original is kept.</p>
          <div className="tl-denoise-list">
            {audioAssets.map((asset) => (
              <div className="tl-denoise-row" key={asset.id}>
                <span title={asset.originalName}>{asset.originalName}</span>
                <button
                  type="button"
                  className="secondary"
                  disabled={denoisingId !== null}
                  onClick={() => void denoiseAsset(asset)}
                >
                  <Sparkles size={12} />{denoisingId === asset.id ? "Denoising…" : "Denoise"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

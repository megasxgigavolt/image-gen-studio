import { Upload } from "lucide-react";
import { projectsClient, type TimelineRecord } from "../../infrastructure/projects-client";

/** State 4 tool panel for the Music toolbar icon — importing music/SFX and
 * the master volume/duck-sensitivity that apply on top of each music clip's
 * own per-clip settings (edited via State 3 when a Music clip is selected). */
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
  async function importMusic() {
    try {
      const asset = await projectsClient.pickAndImportMediaLibraryAsset(videoId, "audio");
      if (!asset) return;
      await refresh(projectsClient.addMusicClip(videoId, asset.id, playheadSeconds));
      addToast(`Added "${asset.originalName}" to the music track.`, "success");
    } catch (caught) {
      addToast(String(caught), "error");
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
        <span className="tl-inspector-label">Master music volume</span>
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
    </div>
  );
}

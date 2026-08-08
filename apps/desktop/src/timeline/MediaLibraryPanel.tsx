import { useEffect, useState } from "react";
import { ImageOff, LoaderCircle, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import { useAppStore } from "../store/app-store";
import { resolveMediaLibraryAssetUrl, resolveVideoAssetUrl } from "../infrastructure/media-cache";
import { projectsClient, type ImageWorkspaceRecord, type MediaLibraryAssetRecord, type MediaLibraryKind, type VideoAssetRecord } from "../infrastructure/projects-client";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/** MIME type used for the native HTML5 drag payload carrying a media library
 * (or generated-clip) asset from the panel onto a timeline track. There's no
 * other drag-and-drop in the app to collide with. */
export const MEDIA_DRAG_MIME = "application/x-ags-media-asset";
export type MediaDragPayload =
  | { source: "media-library"; assetId: string; kind: MediaLibraryKind }
  | { source: "video-asset"; videoAssetId: string }
  | { source: "media-library-batch"; kind: MediaLibraryKind; items: { assetId: string; durationSeconds: number | null }[] };

const TABS: { key: MediaLibraryKind; label: string }[] = [
  { key: "still", label: "Stills" },
  { key: "clip", label: "Clips" },
  { key: "audio", label: "Audio" },
];

export function MediaLibraryPanel({
  videoId,
  workspace,
  renderUrls,
  timelineUpdatedAt,
  onJumpToStill,
  onAddGeneratedClip,
  onAddLibraryAsset,
  addToast,
}: {
  videoId: string;
  workspace: ImageWorkspaceRecord | null;
  renderUrls: Record<string, string>;
  timelineUpdatedAt: string | undefined;
  onJumpToStill: (groupId: string) => void;
  onAddGeneratedClip: (videoAssetId: string) => void;
  onAddLibraryAsset: (asset: MediaLibraryAssetRecord) => void;
  addToast: (message: string, kind?: "success" | "error" | "info") => void;
}) {
  const [activeTab, setActiveTab] = useState<MediaLibraryKind>("still");
  const [libraryAssets, setLibraryAssets] = useState<Record<MediaLibraryKind, MediaLibraryAssetRecord[]>>({ still: [], clip: [], audio: [] });
  const [videoAssets, setVideoAssets] = useState<VideoAssetRecord[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [denoisingId, setDenoisingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const setStage = useAppStore((state) => state.setStage);

  function openContextMenu(event: React.MouseEvent, items: ContextMenuItem[]) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  }

  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeTab]);

  function toggleSelected(event: React.MouseEvent, assetId: string) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId); else next.add(assetId);
      return next;
    });
  }

  async function reload() {
    if (!videoId) return;
    const [stills, clips, audio, generatedClips] = await Promise.all([
      projectsClient.listMediaLibraryAssets(videoId, "still"),
      projectsClient.listMediaLibraryAssets(videoId, "clip"),
      projectsClient.listMediaLibraryAssets(videoId, "audio"),
      projectsClient.listVideoAssets(videoId),
    ]);
    setLibraryAssets({ still: stills, clip: clips, audio });
    setVideoAssets(generatedClips);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, timelineUpdatedAt]);

  useEffect(() => {
    const allLibraryIds = [...libraryAssets.still, ...libraryAssets.clip, ...libraryAssets.audio].map((asset) => asset.id);
    void Promise.all(allLibraryIds.filter((id) => !assetUrls[id]).map(async (id) => {
      const url = await resolveMediaLibraryAssetUrl(id);
      setAssetUrls((current) => ({ ...current, [id]: url }));
    }));
    void Promise.all(videoAssets.filter((asset) => !assetUrls[asset.id]).map(async (asset) => {
      const url = await resolveVideoAssetUrl(asset.id);
      setAssetUrls((current) => ({ ...current, [asset.id]: url }));
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryAssets, videoAssets]);

  async function importAsset(kind: MediaLibraryKind | null) {
    if (importing) return;
    setImporting(true);
    try {
      const asset = await projectsClient.pickAndImportMediaLibraryAsset(videoId, kind);
      if (!asset) return;
      await reload();
      setActiveTab(asset.kind);
      addToast(`Imported ${asset.originalName}.`, "success");
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      setImporting(false);
    }
  }

  async function removeLibraryAsset(asset: MediaLibraryAssetRecord) {
    try {
      await projectsClient.removeMediaLibraryAsset(asset.id);
      await reload();
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  /** Cleans up hiss/hum/static in an Audio-tab file. Non-destructive — the
   * result lands as a new "(denoised)" asset next to the original, which is
   * left untouched. */
  async function denoiseAsset(asset: MediaLibraryAssetRecord) {
    if (denoisingId) return;
    setDenoisingId(asset.id);
    try {
      const result = await projectsClient.denoiseMediaLibraryAsset(asset.id);
      await reload();
      addToast(`Removed background noise — added "${result.originalName}".`, "success");
    } catch (caught) {
      addToast(String(caught), "error");
    } finally {
      setDenoisingId(null);
    }
  }

  function dragStart(event: React.DragEvent, payload: MediaDragPayload) {
    event.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
  }

  /** Imported-asset cards support multi-select (Cmd/Ctrl+click) — dragging a
   * card that's part of a multi-selection (2+) carries every selected asset
   * in that tab, placed onto the timeline in order; dragging a lone card
   * (or one outside the current selection) falls back to the normal
   * single-asset payload. */
  function dragStartAsset(event: React.DragEvent, asset: MediaLibraryAssetRecord, tabAssets: MediaLibraryAssetRecord[]) {
    if (selectedIds.size > 1 && selectedIds.has(asset.id)) {
      const items = tabAssets.filter((candidate) => selectedIds.has(candidate.id)).map((candidate) => ({ assetId: candidate.id, durationSeconds: candidate.durationSeconds }));
      event.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify({ source: "media-library-batch", kind: asset.kind, items } satisfies MediaDragPayload));
      event.dataTransfer.effectAllowed = "copy";
      return;
    }
    dragStart(event, { source: "media-library", assetId: asset.id, kind: asset.kind });
  }

  return (
    <aside className="tl-media-pane">
      <div className="tl-source-tabs">
        {TABS.map((tab) => (
          <button key={tab.key} className={activeTab === tab.key ? "tl-source-tab active" : "tl-source-tab"} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>
      {activeTab === "clip" && (
        <button className="secondary full tl-media-import-btn" disabled={importing} onClick={() => void importAsset("clip")}>
          <Upload size={14} />{importing ? "Importing…" : "+ Import clips"}
        </button>
      )}
      {activeTab === "audio" && (
        <button className="secondary full tl-media-import-btn" disabled={importing} onClick={() => void importAsset("audio")}>
          <Upload size={14} />{importing ? "Importing…" : "+ Import audio"}
        </button>
      )}

      {activeTab === "still" && (
        <div className="tl-media-scroll">
          <div className="tl-source-section">
            <strong>Generated<span>{workspace?.groups.length ?? 0}</span></strong>
            <div className="tl-media-grid">
              {workspace?.groups.map((group) => (
                <button
                  key={group.group.id}
                  className="tl-media-card"
                  title={`Jump to still ${group.group.ordinal}`}
                  onClick={() => onJumpToStill(group.group.id)}
                  onContextMenu={(event) => openContextMenu(event, [
                    { label: "Jump to this still on the timeline", onSelect: () => onJumpToStill(group.group.id) },
                  ])}
                >
                  <span className="tl-source-badge">{group.group.ordinal}</span>
                  {renderUrls[group.imageRenders[0]?.id] ? <img src={renderUrls[group.imageRenders[0]?.id]} alt="" draggable={false} /> : <ImageOff size={16} />}
                </button>
              ))}
              {!workspace?.groups.length && (
                <div className="tl-source-empty">
                  No stills generated yet. Go to Visuals to generate images.<br />
                  <button className="tl-apply-all-btn" onClick={() => setStage("images")}>Go to Visuals →</button>
                </div>
              )}
            </div>
          </div>
          {/* Stills can no longer be imported from the Editor (Visuals-only,
              per design), but assets imported before that rule keep showing
              here so nothing already in a project silently disappears. */}
          {libraryAssets.still.length > 0 && (
            <div className="tl-source-section">
              <strong>Imported<span>{libraryAssets.still.length}</span></strong>
              <div className="tl-media-grid">
                {libraryAssets.still.map((asset) => (
                  <div
                    key={asset.id}
                    className={selectedIds.has(asset.id) ? "tl-media-card multi-selected" : "tl-media-card"}
                    draggable
                    onClick={(event) => toggleSelected(event, asset.id)}
                    onDragStart={(event) => dragStartAsset(event, asset, libraryAssets.still)}
                    onContextMenu={(event) => openContextMenu(event, [
                      { label: "Add to timeline", onSelect: () => onAddLibraryAsset(asset) },
                      { label: "Remove from library", danger: true, onSelect: () => void removeLibraryAsset(asset) },
                    ])}
                  >
                    {assetUrls[asset.id] ? <img src={assetUrls[asset.id]} alt="" draggable={false} /> : <ImageOff size={16} />}
                    <button className="tl-media-card-add" title="Add to timeline at playhead" onClick={() => onAddLibraryAsset(asset)}><Plus size={12} /></button>
                    <button className="tl-media-card-remove" title="Remove from library" onClick={() => void removeLibraryAsset(asset)}><Trash2 size={11} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === "clip" && (
        <div className="tl-media-scroll">
          {!videoAssets.length && !libraryAssets.clip.length ? (
            <div className="tl-source-empty">
              No clips yet. Go to the <button type="button" className="tl-inline-link" onClick={() => setStage("animate")}>Animate</button> stage
              to generate motion clips, or use + Import clips to add your own video or image files.
            </div>
          ) : (
            <>
              <div className="tl-source-section">
                <strong>Generated<span>{videoAssets.length}</span></strong>
                <div className="tl-media-grid">
                  {videoAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="tl-media-card"
                      draggable
                      onDragStart={(event) => dragStart(event, { source: "video-asset", videoAssetId: asset.id })}
                      onContextMenu={(event) => openContextMenu(event, [
                        { label: "Add to timeline", onSelect: () => onAddGeneratedClip(asset.id) },
                      ])}
                      title={asset.prompt || "Veo-generated clip"}
                    >
                      {assetUrls[asset.id] ? <video src={assetUrls[asset.id]} muted /> : <ImageOff size={16} />}
                      <button className="tl-media-card-add" title="Add to timeline at playhead" onClick={() => onAddGeneratedClip(asset.id)}><Plus size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="tl-source-section">
                <strong>Imported<span>{libraryAssets.clip.length}</span></strong>
                <div className="tl-media-grid">
                  {libraryAssets.clip.map((asset) => (
                    <div
                      key={asset.id}
                      className={selectedIds.has(asset.id) ? "tl-media-card multi-selected" : "tl-media-card"}
                      draggable
                      onClick={(event) => toggleSelected(event, asset.id)}
                      onDragStart={(event) => dragStartAsset(event, asset, libraryAssets.clip)}
                      onContextMenu={(event) => openContextMenu(event, [
                        { label: "Add to timeline", onSelect: () => onAddLibraryAsset(asset) },
                        { label: "Remove from library", danger: true, onSelect: () => void removeLibraryAsset(asset) },
                      ])}
                      title={asset.originalName}
                    >
                      {assetUrls[asset.id] ? <video src={assetUrls[asset.id]} muted /> : <ImageOff size={16} />}
                      <button className="tl-media-card-add" title="Add to timeline at playhead" onClick={() => onAddLibraryAsset(asset)}><Plus size={12} /></button>
                      <button className="tl-media-card-remove" title="Remove from library" onClick={() => void removeLibraryAsset(asset)}><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "audio" && (
        <div className="tl-media-scroll">
          <div className="tl-source-section">
            <strong>Imported<span>{libraryAssets.audio.length}</span></strong>
            <div className="tl-media-list">
              {libraryAssets.audio.map((asset) => (
                <div
                  key={asset.id}
                  className={selectedIds.has(asset.id) ? "tl-media-row multi-selected" : "tl-media-row"}
                  draggable
                  onClick={(event) => toggleSelected(event, asset.id)}
                  onDragStart={(event) => dragStartAsset(event, asset, libraryAssets.audio)}
                  onContextMenu={(event) => openContextMenu(event, [
                    { label: "Add to audio track", onSelect: () => onAddLibraryAsset(asset) },
                    { label: "Remove background noise", onSelect: () => void denoiseAsset(asset) },
                    { label: "Remove from library", danger: true, onSelect: () => void removeLibraryAsset(asset) },
                  ])}
                >
                  <span className="tl-media-row-name" title={asset.originalName}>{asset.originalName}</span>
                  <span className="tl-media-row-duration">{asset.durationSeconds ? `${asset.durationSeconds.toFixed(1)}s` : ""}</span>
                  <button className="tl-media-card-add" title="Add to audio track at playhead" onClick={() => onAddLibraryAsset(asset)}><Plus size={12} /></button>
                  <button
                    className="tl-media-card-denoise"
                    title="Remove background noise (adds a cleaned copy, keeps the original)"
                    disabled={denoisingId === asset.id}
                    onClick={() => void denoiseAsset(asset)}
                  >
                    {denoisingId === asset.id ? <LoaderCircle className="spin" size={12} /> : <Wand2 size={12} />}
                  </button>
                  <button className="tl-media-card-remove" title="Remove from library" onClick={() => void removeLibraryAsset(asset)}><Trash2 size={11} /></button>
                </div>
              ))}
              {!libraryAssets.audio.length && <div className="tl-source-empty">No audio files. Use + Import audio to add music or SFX.</div>}
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />
      )}
    </aside>
  );
}

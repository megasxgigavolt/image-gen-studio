import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Download,
  Film,
  LoaderCircle,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useAppStore } from "./store/app-store";
import { resolveRenderUrl, resolveVideoAssetUrl } from "./infrastructure/media-cache";
import {
  projectsClient,
  type ImageWorkspaceRecord,
  type VeoResolution,
  type VideoAssetRecord,
} from "./infrastructure/projects-client";

const MOTION_PRESETS: { label: string; prompt: string }[] = [
  { label: "Slow zoom in", prompt: "Camera slowly zooms in, subtle and smooth." },
  { label: "Slow zoom out", prompt: "Camera slowly zooms out, subtle and smooth." },
  { label: "Gentle pan left", prompt: "Camera gently pans left at a slow, steady pace." },
  { label: "Gentle pan right", prompt: "Camera gently pans right at a slow, steady pace." },
  { label: "Subtle parallax", prompt: "Subtle parallax drift between foreground and background layers; camera mostly static." },
  { label: "Still (no motion)", prompt: "Camera remains completely still, only very minor ambient movement if natural to the subject (e.g. flickering light, drifting particles)." },
];

/** Dedicated pipeline stage between Visuals and Editor for generating Veo
 * animations per still, independent of timeline placement — mirrors
 * ImagesView's filmstrip/preview/tabbed-panel layout (reusing its CSS
 * classes) but targets `video_assets` (grouped by still, via
 * `listVideoAssets`) instead of `image_renders`. */
export function AnimateView() {
  const { activeVideoId, addToast, setStage } = useAppStore();
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [videoAssets, setVideoAssets] = useState<VideoAssetRecord[]>([]);
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [motionPrompt, setMotionPrompt] = useState("");
  const [suggestingPrompt, setSuggestingPrompt] = useState(false);
  const [resolution, setResolution] = useState<VeoResolution>("720p");
  const [job, setJob] = useState<Awaited<ReturnType<typeof projectsClient.getLatestAnimationJob>>>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"prompt" | "settings" | "edit">("prompt");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [planningBulk, setPlanningBulk] = useState<{ done: number; total: number } | null>(null);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");

  async function loadWorkspace() {
    if (!activeVideoId) return;
    setLoading(true);
    setError(null);
    try {
      const [loadedWorkspace, assets] = await Promise.all([
        projectsClient.getImageWorkspace(activeVideoId),
        projectsClient.listVideoAssets(activeVideoId),
      ]);
      setWorkspace(loadedWorkspace);
      setVideoAssets(assets);
      if (!selectedGroupId && loadedWorkspace.groups[0]) setSelectedGroupId(loadedWorkspace.groups[0].group.id);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkspace();
    void projectsClient.getAppSetting("image_settings").then((raw) => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed.aspectRatio === "9:16") setAspectRatio("9:16");
      } catch {
        // Keep the 16:9 default.
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoId]);

  const groupAssets = useMemo(
    () => videoAssets.filter((asset) => asset.groupId === selectedGroupId).sort((a, b) => b.version - a.version),
    [videoAssets, selectedGroupId],
  );

  function latestAssetFor(groupId: string): VideoAssetRecord | undefined {
    return videoAssets.filter((asset) => asset.groupId === groupId).sort((a, b) => b.version - a.version)[0];
  }

  function selectGroup(groupId: string) {
    setSelectedGroupId(groupId);
    const latest = latestAssetFor(groupId);
    setSelectedAssetId(latest?.id ?? null);
    setMotionPrompt(latest?.prompt ?? "");
  }

  useEffect(() => {
    const ids = (workspace?.groups ?? []).map((group) => group.imageRenders[0]?.id).filter(Boolean) as string[];
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [workspace, renderUrls]);

  useEffect(() => {
    const ids = videoAssets.map((asset) => asset.id);
    void Promise.all(ids.filter((id) => !assetUrls[id]).map(async (id) => {
      const url = await resolveVideoAssetUrl(id);
      setAssetUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [videoAssets, assetUrls]);

  async function suggestPrompt() {
    if (!activeVideoId || !selectedGroupId) return;
    setSuggestingPrompt(true);
    setError(null);
    try {
      setMotionPrompt(await projectsClient.suggestAnimationPrompt(activeVideoId, selectedGroupId));
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSuggestingPrompt(false);
    }
  }

  async function generateOne() {
    if (!activeVideoId || !selectedGroupId) return;
    setError(null);
    try {
      setJob(await projectsClient.createAnimationBulkJob(activeVideoId, resolution, [{ groupId: selectedGroupId, prompt: motionPrompt }]));
    } catch (caught) {
      setError(String(caught));
    }
  }

  useEffect(() => {
    if (!job || !activeVideoId || !["queued", "running"].includes(job.status)) return;
    let cancelled = false;
    const interval = window.setInterval(async () => {
      try {
        const latest = await projectsClient.getLatestAnimationJob(activeVideoId);
        if (cancelled || !latest) return;
        setJob(latest);
        if (latest.status === "completed" || latest.status === "failed") {
          const list = await projectsClient.listVideoAssets(activeVideoId);
          if (!cancelled) setVideoAssets(list);
          if (latest.status === "completed") {
            addToast(latest.totalItems > 1 ? `Animated ${latest.completedItems} still${latest.completedItems === 1 ? "" : "s"}.` : "Animation generated.", "success");
          } else {
            const failedItem = latest.items.find((item) => item.status === "failed");
            setError(failedItem?.lastError ?? "Animation generation failed.");
          }
        }
      } catch {
        // Transient — keep polling until it settles.
      }
    }, 1500);
    return () => { cancelled = true; window.clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status, activeVideoId]);

  function moveVersion(delta: number) {
    const index = groupAssets.findIndex((asset) => asset.id === selectedAssetId);
    const next = groupAssets[index + delta];
    if (next) { setSelectedAssetId(next.id); setMotionPrompt(next.prompt); }
  }

  async function downloadAsset(assetId: string) {
    try {
      const path = await projectsClient.getVideoAssetFilePath(assetId);
      await projectsClient.revealInFileManager(path);
    } catch (caught) {
      addToast(String(caught), "error");
    }
  }

  const stillsWithRenderNoAnimation = (workspace?.groups ?? []).filter(
    (group) => group.imageRenders[0] && !latestAssetFor(group.group.id),
  );
  const stillsMissingRender = (workspace?.groups ?? []).filter((group) => !group.imageRenders[0]).length;

  async function runBulkAnimate(targets: { groupId: string; narration: string }[]) {
    if (!activeVideoId || targets.length === 0) return;
    setError(null);
    setPlanningBulk({ done: 0, total: targets.length });
    try {
      const items: { groupId: string; prompt: string }[] = [];
      for (const target of targets) {
        try {
          const prompt = await projectsClient.suggestAnimationPrompt(activeVideoId, target.groupId);
          items.push({ groupId: target.groupId, prompt });
        } catch {
          // Skip a still whose prompt suggestion failed — the rest still proceed.
        }
        setPlanningBulk((current) => current ? { done: current.done + 1, total: current.total } : current);
      }
      if (items.length === 0) throw new Error("Could not plan motion prompts for any still.");
      setJob(await projectsClient.createAnimationBulkJob(activeVideoId, resolution, items));
      setBulkOpen(false);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setPlanningBulk(null);
    }
  }

  function requestBulkAnimate() {
    const targets = stillsWithRenderNoAnimation.map((group) => ({ groupId: group.group.id, narration: "" }));
    if (targets.length === 0) return;
    const anyAlreadyAnimated = videoAssets.length > 0;
    if (anyAlreadyAnimated) { setConfirmBulk(true); return; }
    void runBulkAnimate(targets);
  }

  const selectedGroup = workspace?.groups.find((group) => group.group.id === selectedGroupId);
  const narration = useMemo(() => {
    if (!workspace || !selectedGroup) return "";
    const ids = new Set(selectedGroup.group.sentenceIds);
    return workspace.sentences.filter((sentence) => ids.has(sentence.id)).map((sentence) => sentence.text).join(" ");
  }, [workspace, selectedGroup]);

  if (!activeVideoId) return <section className="view"><div className="empty-state">Open a video first.</div></section>;
  if (loading && !workspace) return <section className="view"><div className="empty-state">Loading stills…</div></section>;

  return (
    <section className="view images-view">
      {error && <div className="error-toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
      {confirmBulk && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setConfirmBulk(false)}>
          <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Animate all stills</p>
            <h2>Animate all remaining stills?</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>
              This generates a new animation for every still that doesn't have one yet ({stillsWithRenderNoAnimation.length}).
              Stills that already have an animation are left as-is — animate those individually if you want a new version.
            </p>
            <div className="footer-actions">
              <button className="secondary" onClick={() => setConfirmBulk(false)}>Cancel</button>
              <button className="primary" onClick={() => { setConfirmBulk(false); void runBulkAnimate(stillsWithRenderNoAnimation.map((group) => ({ groupId: group.group.id, narration: "" }))); }}>Animate All Stills</button>
            </div>
          </section>
        </div>
      )}
      {bulkOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setBulkOpen(false)}>
          <div className="modal bulk-modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Animate All Stills</h2>
            <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55 }}>
              Plans a motion prompt for every still that has a generated image but no animation yet ({stillsWithRenderNoAnimation.length} of {workspace?.groups.length ?? 0}),
              then generates them sequentially. {stillsMissingRender > 0 && `${stillsMissingRender} still${stillsMissingRender === 1 ? "" : "s"} without an image will be skipped.`}
            </p>
            <div className="tl-inspector-group" style={{ borderTop: "none", paddingTop: 0 }}>
              <span className="tl-inspector-label">Resolution</span>
              <div className="tl-preset-grid two">
                {(["720p", "1080p"] as VeoResolution[]).map((value) => (
                  <button key={value} className={resolution === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setResolution(value)}><span>{value}</span></button>
                ))}
              </div>
            </div>
            {planningBulk ? (
              <div className="tl-export-progress">
                <div className="progress-heading"><LoaderCircle className="spin" size={20} /><strong>Planning motion prompts…</strong></div>
                <span>{planningBulk.done} / {planningBulk.total} stills</span>
                <div className="loading-bar determinate"><i style={{ width: `${(planningBulk.done / Math.max(1, planningBulk.total)) * 100}%` }} /></div>
              </div>
            ) : (
              <div className="footer-actions">
                <button className="secondary" onClick={() => setBulkOpen(false)}>Cancel</button>
                <button className="primary" disabled={stillsWithRenderNoAnimation.length === 0} onClick={requestBulkAnimate}><WandSparkles size={15} />Animate All Stills</button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="page-heading">
        <div>
          <h1>Animate</h1>
          <p>Generate motion for each still — independent of where it ends up on the Editor timeline.</p>
        </div>
        <div className="heading-actions">
          <button className="secondary" onClick={() => setBulkOpen(true)} disabled={!workspace?.groups.length || loading}><WandSparkles size={17} />Bulk Generation</button>
          <button className="primary" onClick={() => setStage("timeline")} disabled={!workspace?.groups.length}><Film size={17} />Continue to Editor →</button>
        </div>
      </div>
      <div className="image-workspace">
        <aside className="stills">
          <div className="stills-heading">
            <div className="stills-heading-left">
              <span className="stills-heading-label">Stills</span>
              <span className="stills-heading-count">{workspace?.groups.length ?? 0}</span>
            </div>
          </div>
          <div className="still-list">
            {(workspace?.groups ?? []).map((group) => {
              const thumb = group.imageRenders[0];
              const thumbUrl = thumb ? renderUrls[thumb.id] : undefined;
              const latestAsset = latestAssetFor(group.group.id);
              const item = job?.items.find((candidate) => candidate.groupId === group.group.id);
              const isGenerating = item?.status === "running" || item?.status === "queued";
              const isFailed = item?.status === "failed";
              const statusKey = isGenerating ? "generating" : isFailed ? "failed" : latestAsset ? "animated" : "empty";
              const statusLabel = isGenerating ? "Generating" : isFailed ? "Generation failed" : latestAsset ? "Animated" : "Not yet animated";
              return (
                <button
                  key={group.group.id}
                  className={`still-select${group.group.id === selectedGroupId ? " active" : ""}`}
                  title={statusLabel}
                  onClick={() => selectGroup(group.group.id)}
                >
                  <div className={`still-thumb ${aspectRatio === "9:16" ? "portrait" : "landscape"}${thumbUrl ? "" : " empty"}`}>
                    {thumbUrl ? <img src={thumbUrl} alt={`Still ${group.group.ordinal} preview`} /> : <div className="still-thumb-empty"><Film size={18} /><span>No image yet</span></div>}
                    <span className="still-number">{group.group.ordinal}</span>
                    <span className={`still-status-badge ${statusKey === "animated" ? "generated" : statusKey}`} aria-label={statusLabel}>
                      {statusKey === "animated" && <Check size={11} />}
                      {statusKey === "generating" && <LoaderCircle size={11} className="spin" />}
                      {statusKey === "failed" && <AlertTriangle size={11} />}
                      {statusKey === "empty" && <Circle size={9} />}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          {!workspace && <div className="empty-state">Loading stills…</div>}
        </aside>
        <div className="preview">
          {job && ["queued", "running"].includes(job.status) && (
            <div className="job-status">
              <div><strong>Animating: {job.status}</strong><span>{job.completedItems + job.failedItems}/{job.totalItems} done · {job.failedItems} failed</span></div>
              <progress value={job.completedItems + job.failedItems} max={job.totalItems} />
              <div>
                <button className="secondary" onClick={() => void projectsClient.controlAnimationJob(job.id, "stop").then(setJob)}>Stop</button>
              </div>
            </div>
          )}
          <header>
            <div>
              <span className="timestamp-heading">{selectedGroup ? `Still ${selectedGroup.group.ordinal}` : ""}</span>
              <strong className="production-copy narration-preview">{narration}</strong>
            </div>
          </header>
          <div className="preview-art">
            {selectedAssetId && assetUrls[selectedAssetId] ? (
              <figure className={`image-frame clickable-frame ${aspectRatio === "9:16" ? "portrait" : "landscape"}`}>
                <video src={assetUrls[selectedAssetId]} controls loop style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                <div className="image-actions">
                  <button className="image-action-btn" title="Download this animation" onClick={() => void downloadAsset(selectedAssetId)}><Download size={16} /><span>Download</span></button>
                </div>
              </figure>
            ) : (
              <div className={`image-frame empty-frame ${aspectRatio === "9:16" ? "portrait" : "landscape"}`}>
                <div className="image-empty"><Film size={34} /><strong>No animation generated yet</strong><span>Use the Prompt tab to generate one</span></div>
              </div>
            )}
          </div>
          <footer>
            <div className="version-nav">
              <button disabled={groupAssets.findIndex((a) => a.id === selectedAssetId) >= groupAssets.length - 1} onClick={() => moveVersion(1)}><ChevronLeft size={16} />Older</button>
              <strong>{(() => {
                const total = groupAssets.length;
                const index = groupAssets.findIndex((a) => a.id === selectedAssetId);
                return index >= 0 ? `Version ${total - index} / ${total}` : "No versions";
              })()}</strong>
              <button disabled={groupAssets.findIndex((a) => a.id === selectedAssetId) <= 0} onClick={() => moveVersion(-1)}>Newer<ChevronRight size={16} /></button>
            </div>
          </footer>
        </div>
        <aside className="prompt-panel">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "prompt"} className={tab === "prompt" ? "active" : ""} onClick={() => setTab("prompt")}>Prompt</button>
            <button role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
            <button role="tab" aria-selected={tab === "edit"} className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>Edit</button>
          </div>
          {tab === "prompt" && (
            <div className="prompt-fields">
              <span className="field-heading">Motion presets</span>
              <div className="tl-preset-grid two">
                {MOTION_PRESETS.map((preset) => (
                  <button key={preset.label} className="tl-preset-btn" onClick={() => setMotionPrompt(preset.prompt)}><span>{preset.label}</span></button>
                ))}
              </div>
              <label>
                <span className="field-heading">Motion prompt</span>
                <textarea
                  className="production-copy"
                  value={motionPrompt}
                  onChange={(event) => setMotionPrompt(event.target.value)}
                  placeholder="e.g. Camera slowly pushes forward, gentle water movement, subject drifts left to right."
                />
              </label>
              <button className="secondary full" onClick={() => void suggestPrompt()} disabled={!selectedGroupId || suggestingPrompt}>
                {suggestingPrompt ? <><LoaderCircle className="spin" size={14} />Suggesting…</> : <><Sparkles size={15} />Suggest prompt</>}
              </button>
              <div className="tl-inspector-group" style={{ borderTop: "none", paddingTop: 0 }}>
                <span className="tl-inspector-label">Resolution</span>
                <div className="tl-preset-grid two">
                  {(["720p", "1080p"] as VeoResolution[]).map((value) => (
                    <button key={value} className={resolution === value ? "tl-preset-btn active" : "tl-preset-btn"} onClick={() => setResolution(value)}><span>{value}</span></button>
                  ))}
                </div>
              </div>
              <button
                className="primary full generate-image-btn"
                onClick={() => void generateOne()}
                disabled={!selectedGroupId || !motionPrompt.trim() || !selectedGroup?.imageRenders[0] || Boolean(job && ["queued", "running"].includes(job.status))}
              >
                {job && ["queued", "running"].includes(job.status) ? <><LoaderCircle className="spin" size={14} />Generating…</> : <><CheckCircle2 size={15} />Generate</>}
              </button>
              {!selectedGroup?.imageRenders[0] && <p className="tl-source-hint">This still needs a generated image before it can be animated — go to Visuals first.</p>}
            </div>
          )}
          {tab === "settings" && (
            <div className="prompt-fields">
              <div className="panel-section-heading"><h3>Settings</h3><small>Shared with Visuals</small></div>
              <p className="tl-source-hint">
                Aspect ratio, camera angle, mood, lighting, and other image settings are shared with the Visuals stage —
                edit them there and they apply here too.
              </p>
            </div>
          )}
          {tab === "edit" && (
            <div className="edit-panel">
              <h3>Edit existing animation</h3>
              <p className="tl-source-hint">Editing a generated animation isn't available yet — generate a new version instead.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

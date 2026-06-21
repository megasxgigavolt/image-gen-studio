import {
  FolderOpen,
  Home,
  Image,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  Upload,
  X,
  WandSparkles,
  Download,
  PanelsTopLeft,
  LoaderCircle,
  GripVertical,
  Check,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { type ChangeEvent, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppStage, useAppStore } from "./store/app-store";
import { log } from "./infrastructure/logger";
import {
  projectsClient,
  type ChannelRecord,
  type ResumeRecord,
  type VideoRecord,
  type VisualPlanRecord,
  type ImageWorkspaceRecord,
  type ImageJobRecord,
  type ImageRenderRecord,
  type PromptVersionRecord,
  type TimelineRecord,
} from "./infrastructure/projects-client";

const navItems: { stage: AppStage; label: string; icon: typeof Home }[] = [
  { stage: "home", label: "Home", icon: Home },
  { stage: "inputs", label: "Production", icon: Upload },
  { stage: "images", label: "Images", icon: Image },
];
const imageWorkspaceCache = new Map<string, ImageWorkspaceRecord>();

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function Sidebar() {
  const { stage, setStage, activeVideoId } = useAppStore();
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => setStage("home")}>
        <span className="brand-mark"><span /></span>
        <span>Auto Gen <strong>Studio</strong></span>
      </button>
      <nav>
        {navItems.map(({ stage: itemStage, label, icon: Icon }) => (
          <button
            className={(itemStage === "inputs" ? ["inputs", "visual-plan"].includes(stage) : stage === itemStage) ? "nav-item active" : "nav-item"}
            key={itemStage}
            onClick={() => setStage(itemStage === "inputs" && stage === "images" ? "visual-plan" : itemStage)}
            disabled={(itemStage !== "home" && !activeVideoId) || (itemStage === "images" && stage === "inputs")}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <button className="nav-item settings" disabled><Settings size={18} /><span>Preferences · soon</span></button>
      <button className="nav-item" disabled><PanelsTopLeft size={18} /><span>Timeline · in production</span></button>
    </aside>
  );
}

function Header() {
  const {
    theme,
    toggleTheme,
    activeChannelName,
    activeVideoTitle,
  } = useAppStore();
  return (
    <header className="topbar">
      <div>
        <span>{activeChannelName ?? "Auto Gen Studio"}</span>
        {activeVideoTitle && <><b>/</b><strong>{activeVideoTitle}</strong></>}
      </div>
      <div className="top-actions">
        <span className="saved">Saved locally</span>
        <button className="icon-button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
      </div>
    </header>
  );
}

function HomeView() {
  const { setStage, setActiveProject } = useAppStore();
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [resume, setResume] = useState<ResumeRecord | null>(null);
  const [dialog, setDialog] = useState<"channel" | "video" | "trash" | null>(null);
  const [trashedChannels, setTrashedChannels] = useState<ChannelRecord[]>([]);
  const [trashedVideos, setTrashedVideos] = useState<VideoRecord[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [channelRecords, resumeRecord] = await Promise.all([
        projectsClient.listChannels(),
        projectsClient.getResume(),
      ]);
      setChannels(channelRecords);
      setResume(resumeRecord);
      const channelId = selectedChannelId ?? channelRecords[0]?.id ?? null;
      setSelectedChannelId(channelId);
      setVideos(channelId ? await projectsClient.listVideos(channelId) : []);
    } catch (caught) {
      setError(String(caught));
      log("error", "workspace_load_failed", { message: String(caught) });
    } finally {
      setLoading(false);
    }
  }, [selectedChannelId]);

  useEffect(() => {
    // Loading external project state is the purpose of this mount effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWorkspace();
  }, [loadWorkspace]);

  async function selectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    setVideos(await projectsClient.listVideos(channelId));
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      if (dialog === "channel") {
        const channel = await projectsClient.createChannel(name.trim());
        setSelectedChannelId(channel.id);
      } else if (dialog === "video" && selectedChannelId) {
        await projectsClient.createVideo(selectedChannelId, name.trim());
      }
      setDialog(null);
      setName("");
      await loadWorkspace();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function openVideo(video: VideoRecord) {
    const channel = channels.find((candidate) => candidate.id === video.channelId);
    if (!channel) return;
    setActiveProject(channel.id, channel.name, video.id, video.title);
    await projectsClient.setResume(channel.id, video.id, video.stage);
    await projectsClient.createSnapshot(video.id, {
      reason: "video-opened",
      stage: video.stage,
    });
    setStage(video.stage);
  }

  async function resumeVideo() {
    if (!resume?.channelId || !resume.videoId) return;
    const channel = channels.find((candidate) => candidate.id === resume.channelId);
    const channelVideos = await projectsClient.listVideos(resume.channelId);
    const video = channelVideos.find((candidate) => candidate.id === resume.videoId);
    if (channel && video) await openVideo(video);
  }

  async function deleteChannel(channelId: string) {
    await projectsClient.trashChannel(channelId);
    setSelectedChannelId(null);
    await loadWorkspace();
  }

  async function deleteVideo(videoId: string) {
    await projectsClient.trashVideo(videoId);
    await loadWorkspace();
  }

  async function openTrash() {
    const channelTrash = await projectsClient.listChannels(true);
    const videoTrash = (
      await Promise.all([...channels, ...channelTrash].map((channel) => projectsClient.listVideos(channel.id, true)))
    ).flat();
    setTrashedChannels(channelTrash);
    setTrashedVideos(videoTrash);
    setDialog("trash");
  }

  async function restoreChannel(channelId: string) {
    await projectsClient.restoreChannel(channelId);
    setTrashedChannels((items) => items.filter((item) => item.id !== channelId));
    await loadWorkspace();
  }

  async function restoreVideo(videoId: string) {
    await projectsClient.restoreVideo(videoId);
    setTrashedVideos((items) => items.filter((item) => item.id !== videoId));
    await loadWorkspace();
  }

  async function importBundle() {
    try {
      const imported = await projectsClient.importProjectBundle();
      if (imported) {
        setSelectedChannelId(imported.channelId);
        await loadWorkspace();
      }
    } catch (caught) { setError(String(caught)); }
  }

  const resumeVideoRecord = videos.find((video) => video.id === resume?.videoId);
  return (
    <section className="view">
      <div className="page-heading">
        <div><p className="eyebrow">Workspace</p><h1>Good evening, Ahmed</h1><p>Continue a video or begin a new production.</p></div>
        <button className="primary" disabled={!selectedChannelId} onClick={() => setDialog("video")}><Plus size={17} />New video</button>
      </div>
      {resume && (
        <button className="resume-band" onClick={() => void resumeVideo()}>
          <div><span>CONTINUE WHERE YOU LEFT OFF</span><h2>{resumeVideoRecord?.title ?? "Resume last video"}</h2><p>{resume.stage.replace("-", " ")} · Saved locally</p></div>
          <strong>→</strong>
        </button>
      )}
      <div className="section-heading"><h2>Channels</h2><div><button onClick={() => void importBundle()}><Upload size={14} /> Import project</button><button onClick={() => void openTrash()}><Trash2 size={14} /> Trash</button><button onClick={() => setDialog("channel")}>+ Add channel</button></div></div>
      {error && <div className="inline-error">{error}</div>}
      {loading && <div className="empty-state">Loading local workspace…</div>}
      {!loading && channels.length === 0 && (
        <div className="empty-state"><FolderOpen size={28} /><h2>Create your first channel</h2><p>Videos and assets will be stored locally in its project folder.</p><button className="primary" onClick={() => setDialog("channel")}><Plus size={16} />Add channel</button></div>
      )}
      {!loading && channels.length > 0 && (
      <div className="home-grid">
        <div className="channel-list">
          {channels.map((channel) => (
            <div className={selectedChannelId === channel.id ? "channel active" : "channel"} key={channel.id}>
              <button onClick={() => void selectChannel(channel.id)}>
                <span>{channel.name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase()}</span>
                <div><strong>{channel.name}</strong><small>{channel.videoCount} videos</small></div>
              </button>
              <button className="row-action" aria-label={`Move ${channel.name} to trash`} onClick={() => void deleteChannel(channel.id)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="video-grid">
          {videos.map((video, index) => (
            <article className="video-card" key={video.id}>
              <button className="video-open" onClick={() => void openVideo(video)}>
                <div className={`video-art art-${(index % 3) + 1}`}><span>{video.progress}%</span></div>
                <div><small>{video.stage.replace("-", " ").toUpperCase()}</small><h3>{video.title}</h3><p>Saved locally · {new Date(video.updatedAt).toLocaleDateString()}</p><i style={{ width: `${video.progress}%` }} /></div>
              </button>
              <button className="card-trash" aria-label={`Move ${video.title} to trash`} onClick={() => void deleteVideo(video.id)}><Trash2 size={15} /></button>
            </article>
          ))}
          {videos.length === 0 && <div className="empty-state compact"><h2>No videos yet</h2><button className="primary" onClick={() => setDialog("video")}><Plus size={16} />Create video</button></div>}
        </div>
      </div>
      )}
      {dialog === "trash" && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <section className="modal trash-modal" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">Recoverable items</p><h2>Trash</h2>
            {trashedChannels.length === 0 && trashedVideos.length === 0 && <p>Trash is empty.</p>}
            {[...trashedChannels.map((channel) => ({ id: channel.id, label: channel.name, kind: "Channel" })),
              ...trashedVideos.map((video) => ({ id: video.id, label: video.title, kind: "Video" }))].map((item) => (
                <div className="trash-row" key={`${item.kind}-${item.id}`}><div><strong>{item.label}</strong><small>{item.kind}</small></div><button className="secondary" onClick={() => void (item.kind === "Channel" ? restoreChannel(item.id) : restoreVideo(item.id))}><Undo2 size={14} />Restore</button></div>
              ))}
            <div className="footer-actions"><button className="secondary" onClick={() => setDialog(null)}>Close</button></div>
          </section>
        </div>
      )}
      {(dialog === "channel" || dialog === "video") && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDialog(null)}>
          <form className="modal" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">{dialog === "channel" ? "New workspace" : "New production"}</p>
            <h2>{dialog === "channel" ? "Create channel" : "Create video"}</h2>
            <label>{dialog === "channel" ? "Channel name" : "Video title"}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
            <div className="footer-actions"><button type="button" className="secondary" onClick={() => setDialog(null)}>Cancel</button><button className="primary" type="submit">Create</button></div>
          </form>
        </div>
      )}
    </section>
  );
}

function InputsView() {
  const { setStage, activeVideoId } = useAppStore();
  const [script, setScript] = useState("");
  const [pacing, setPacing] = useState(8);
  const [pacingPreset, setPacingPreset] = useState<"calm" | "balanced" | "fast" | "custom">("balanced");
  const [pacingMin, setPacingMin] = useState(6);
  const [pacingMax, setPacingMax] = useState(10);
  const [audio, setAudio] = useState<import("./infrastructure/projects-client").InputAssetRecord | null>(null);
  const [status, setStatus] = useState("Loading source material…");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [hasPlan, setHasPlan] = useState(false);
  const [generatedInputSignature, setGeneratedInputSignature] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({
    percent: 0,
    stage: "Preparing visual plan",
    detail: "",
  });
  const scriptFileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
  const inputSignature = useMemo(() => JSON.stringify({
    script,
    audioId: audio?.id ?? null,
    pacingPreset,
    pacingMin,
    pacingMax,
  }), [audio?.id, pacingMax, pacingMin, pacingPreset, script]);

  useEffect(() => {
    if (!activeVideoId) return;
    void projectsClient.getVideoInputs(activeVideoId).then((inputs) => {
      setScript(inputs.scriptText);
      setPacing(inputs.pacingSeconds);
      setPacingPreset(inputs.pacingPreset);
      setPacingMin(inputs.pacingMinSeconds);
      setPacingMax(inputs.pacingMaxSeconds);
      setAudio(inputs.audio);
      setStatus("Saved locally");
      setHydrated(true);
      const signature = JSON.stringify({
        script: inputs.scriptText,
        audioId: inputs.audio?.id ?? null,
        pacingPreset: inputs.pacingPreset,
        pacingMin: inputs.pacingMinSeconds,
        pacingMax: inputs.pacingMaxSeconds,
      });
      void projectsClient.getVisualPlan(activeVideoId)
        .then(() => { setHasPlan(true); setGeneratedInputSignature(signature); })
        .catch(() => { setHasPlan(false); setGeneratedInputSignature(null); });
    }).catch((caught) => setError(String(caught)));
  }, [activeVideoId]);

  useEffect(() => {
    if (!activeVideoId || !hydrated) return;
    const timeout = window.setTimeout(() => {
      void projectsClient.saveVideoInputs(activeVideoId, script, pacing)
        .then(() => setStatus("Saved locally"))
        .catch((caught) => { setError(String(caught)); setStatus("Save failed"); });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [activeVideoId, hydrated, pacing, script]);

  async function choosePacing(preset: "calm" | "balanced" | "fast" | "custom", min = pacingMin, max = pacingMax) {
    if (!activeVideoId) return;
    const ranges = { calm: [10, 16], balanced: [6, 10], fast: [3, 6], custom: [min, max] } as const;
    const [nextMin, nextMax] = ranges[preset];
    setPacingPreset(preset); setPacingMin(nextMin); setPacingMax(nextMax);
    setPacing(Math.round((nextMin + nextMax) / 2)); setStatus("Saving…");
    await projectsClient.saveVideoPacing(activeVideoId, preset, nextMin, nextMax);
    setStatus("Saved locally");
  }

  async function importAsset(kind: "audio") {
    if (!activeVideoId) return;
    const asset = await projectsClient.pickAndImportAsset(activeVideoId, kind);
    if (!asset) {
      audioFileRef.current?.click();
      return;
    }
    setAudio(asset);
  }

  async function importBrowserAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeVideoId) return;
    try {
      setAudio(await projectsClient.importBrowserAsset(activeVideoId, "audio", file));
      setStatus("Saved locally");
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function importScript() {
    try {
      const text = await projectsClient.pickScriptText();
      if (text !== null) setScript(text);
      else scriptFileRef.current?.click();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function importBrowserScript(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setScript(await projectsClient.readBrowserScript(file));
      setStatus("Saving…");
    } catch (caught) { setError(String(caught)); }
  }

  async function removeAsset(assetId: string) {
    await projectsClient.removeInputAsset(assetId);
    if (audio?.id === assetId) setAudio(null);
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const ready = Boolean(script.trim() && audio);
  async function generatePlan() {
    if (!activeVideoId) return;
    setGenerating(true);
    setGenerationProgress({ percent: 0, stage: "Preparing visual plan", detail: "" });
    setError(null);
    let unlisten: (() => void) | undefined;
    try {
      try {
        unlisten = await listen<{
          videoId: string;
          percent: number;
          stage: string;
          detail: string;
        }>("visual-plan-progress", ({ payload }) => {
          if (payload.videoId === activeVideoId) {
            setGenerationProgress({
              percent: payload.percent,
              stage: payload.stage,
              detail: payload.detail,
            });
          }
        });
      } catch {
        // Browser preview has no native event bridge.
      }
      await projectsClient.generateVisualPlan(activeVideoId);
      setHasPlan(true);
      setGeneratedInputSignature(inputSignature);
      setStage("visual-plan");
    } catch (caught) {
      setError(String(caught));
    } finally {
      unlisten?.();
      setGenerating(false);
    }
  }
  return (
    <section className="view">
      <input ref={scriptFileRef} className="visually-hidden" type="file" accept=".txt,text/plain" onChange={(event) => void importBrowserScript(event)} />
      <input ref={audioFileRef} className="visually-hidden" type="file" accept=".wav,.mp3,.m4a,.aac,.flac,audio/*" onChange={(event) => void importBrowserAudio(event)} />
      {generating && <GenerationProgress progress={generationProgress} />}
      <div className="workflow-tabs"><button className="active">1 · Source & pacing</button><button disabled={!hasPlan} onClick={() => setStage("visual-plan")}>2 · Visual plan</button></div>
      <div className="page-heading"><div><p className="eyebrow">Stage 1 of 3</p><h1>Source material</h1><p>Add narration and references that will guide the visual plan.</p></div><span className="save-state">{status}</span></div>
      {!activeVideoId && <div className="inline-error">Open or create a video before adding source material.</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="inputs-grid">
        <article className="panel script-panel">
          <div className="panel-heading"><div><h2>Script</h2><p>Paste narration or import a UTF-8 text file.</p></div><button className="secondary" onClick={() => void importScript()}><Upload size={15} />Import</button></div>
          <textarea value={script} onChange={(event) => { setScript(event.target.value); setStatus("Saving…"); }} placeholder="Paste the final narration script here…" />
          <footer><span>{wordCount.toLocaleString()} words</span><span>Approx. {Math.ceil(wordCount / 150)} min</span></footer>
        </article>
        <div className="panel-stack">
          <article className="panel"><div className="panel-heading"><div><h2>Narration audio</h2><p>Used for word-level timing.</p></div><button className="secondary" onClick={() => void importAsset("audio")}><Upload size={15} />{audio ? "Replace" : "Import"}</button></div>{audio ? <div className="file-row"><span>♪</span><div><strong>{audio.originalName}</strong><small>{(audio.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></div><button className="icon-button" onClick={() => void removeAsset(audio.id)}><X size={15} /></button></div> : <div className="asset-empty">WAV, MP3, M4A, AAC, or FLAC</div>}</article>
          <article className="panel"><div className="pacing-heading"><div><h2>Scene pacing</h2><p>Preferred duration range per still</p></div><strong>{pacingMin}–{pacingMax} sec</strong></div><div className="pacing-options">{([["calm","Calm","10–16s"],["balanced","Balanced","6–10s"],["fast","Fast","3–6s"],["custom","Custom","Choose range"]] as const).map(([value,label,detail]) => <button key={value} className={pacingPreset === value ? "active" : ""} onClick={() => void choosePacing(value)}><strong>{label}</strong><small>{detail}</small></button>)}</div><div className="custom-pacing"><label>Minimum<input type="number" min="2" max="30" value={pacingMin} disabled={pacingPreset !== "custom"} onChange={(event) => setPacingMin(Number(event.target.value))} /></label><label>Maximum<input type="number" min="2" max="30" value={pacingMax} disabled={pacingPreset !== "custom"} onChange={(event) => setPacingMax(Number(event.target.value))} /></label><button className="secondary" disabled={pacingPreset !== "custom"} onClick={() => void choosePacing("custom", pacingMin, pacingMax)}>Apply</button></div></article>
          <article className={ready ? "readiness ready" : "readiness"}><strong>{ready ? "Ready for visual planning" : "Source material incomplete"}</strong><span>{ready ? "Script and narration audio are available." : "Add a script and narration audio to continue."}</span></article>
        </div>
      </div>
      <div className="footer-actions"><button className="secondary" onClick={() => setStage("home")}>Back</button><button className="primary" disabled={!ready || !activeVideoId || generating || (hasPlan && inputSignature === generatedInputSignature)} onClick={() => void generatePlan()}>{generating ? <><LoaderCircle className="spin" size={16} />Generating…</> : "Generate visual plan →"}</button></div>
    </section>
  );
}

function VisualPlanView() {
  const { activeVideoId, setStage } = useAppStore();
  const [plan, setPlan] = useState<VisualPlanRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedSentenceId, setDraggedSentenceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  useEffect(() => {
    if (!activeVideoId) return;
    void projectsClient.getVisualPlan(activeVideoId).then(setPlan).catch((caught) => setError(String(caught)));
  }, [activeVideoId]);

  async function moveSentence(sentenceId: string, targetGroupId: string) {
    if (!activeVideoId) return;
    try { setPlan(await projectsClient.movePlanSentence(activeVideoId, sentenceId, targetGroupId)); }
    catch (caught) { setError(String(caught)); }
  }

  async function resetPlan() {
    if (!activeVideoId) return;
    setPlan(await projectsClient.resetVisualPlan(activeVideoId));
  }

  async function createGroup(sentenceId: string, insertIndex: number) {
    if (!activeVideoId) return;
    try { setPlan(await projectsClient.createPlanGroup(activeVideoId, sentenceId, insertIndex)); }
    catch (caught) { setError(String(caught)); }
  }

  function finishDrag(event: DragEndEvent) {
    const sentenceId = String(event.active.id).replace(/^sentence:/, "");
    const target = event.over ? String(event.over.id) : "";
    setDraggedSentenceId(null);
    setDropTarget(null);
    if (!sentenceId || !target) return;
    if (target.startsWith("group:")) {
      void moveSentence(sentenceId, target.replace(/^group:/, ""));
    } else if (target.startsWith("divider:")) {
      void createGroup(sentenceId, Number(target.replace(/^divider:/, "")));
    }
  }

  return (
    <section className="view">
      <div className="workflow-tabs"><button onClick={() => setStage("inputs")}>1 · Source & pacing</button><button className="active">2 · Visual plan</button></div>
      <div className="page-heading">
        <div><p className="eyebrow">Stage 2 of 3</p><h1>Visual plan</h1><p>Drag a sentence into an adjacent still to regroup it. Chronological order remains enforced.</p></div>
        <div className="heading-actions"><button className="secondary" disabled={!plan} onClick={() => void resetPlan()}>Reset original</button><button className="primary" disabled={!plan} onClick={() => setStage("images")}>Continue to images →</button></div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {!plan && !error && <div className="empty-state">Loading visual plan…</div>}
      {plan && <><div className="plan-summary"><strong>{plan.groups.length} stills</strong><span>{formatTime(plan.sentences.at(-1)?.endSeconds ?? 0)} total · Average {((plan.sentences.at(-1)?.endSeconds ?? 0) / plan.groups.length).toFixed(1)} sec · {plan.timingSource}</span></div>
      <DndContext
        sensors={sensors}
        onDragStart={(event) => setDraggedSentenceId(String(event.active.id).replace(/^sentence:/, ""))}
        onDragOver={(event) => setDropTarget(event.over ? String(event.over.id) : null)}
        onDragCancel={() => { setDraggedSentenceId(null); setDropTarget(null); }}
        onDragEnd={finishDrag}
      >
      <div className="plan-list">
        <StillDivider insertIndex={0} active={dropTarget === "divider:0"} />
        {plan.groups.map((group, index) => {
          const members = group.sentenceIds.map((id) => plan.sentences.find((sentence) => sentence.id === id)).filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence)).sort((a,b) => a.ordinal-b.ordinal);
          const timing = { startSeconds: members[0].startSeconds, endSeconds: members.at(-1)!.endSeconds, durationSeconds: members.at(-1)!.endSeconds-members[0].startSeconds, members };
          return <div className="plan-group-shell" key={group.id}>
            <DroppableStill groupId={group.id} active={dropTarget === `group:${group.id}`}>
              <span className="plan-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="timing"><strong>{formatTime(timing.startSeconds)} – {formatTime(timing.endSeconds)}</strong><small>{timing.durationSeconds.toFixed(1)} sec</small></div>
              <div className="sentences">
                {timing.members.map((sentence) => (
                  <DraggableSentence key={sentence.id} sentence={sentence} active={draggedSentenceId === sentence.id} />
                ))}
              </div>
              <div className="scene-label"><span>{group.kind}</span><small>{group.label}</small></div>
            </DroppableStill>
            <StillDivider insertIndex={index + 1} active={dropTarget === `divider:${index + 1}`} />
          </div>;
        })}
      </div>
      </DndContext></>}
    </section>
  );
}

type PlanSentenceRecord = VisualPlanRecord["sentences"][number];

function DraggableSentence({ sentence, active }: { sentence: PlanSentenceRecord; active: boolean }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: `sentence:${sentence.id}` });
  return <div
    ref={setNodeRef}
    className={active ? "sentence dragging" : "sentence"}
    style={{ transform: CSS.Translate.toString(transform), touchAction: "none" }}
    {...listeners}
    {...attributes}
  >
    <b title="Drag sentence"><GripVertical size={18} /></b>
    <span>{sentence.text}</span>
    <small>{formatTime(sentence.startSeconds)}</small>
  </div>;
}

function DroppableStill({ groupId, active, children }: { groupId: string; active: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupId}` });
  return <article ref={setNodeRef} className={active || isOver ? "plan-row drag-over" : "plan-row"}>{children}</article>;
}

function StillDivider({ insertIndex, active }: { insertIndex: number; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `divider:${insertIndex}` });
  return <div ref={setNodeRef} className={active || isOver ? "drop-divider drag-over" : "drop-divider"} />;
}

function LoadingOverlay({ label }: { label: string }) {
  return <div className="loading-overlay" role="status"><div className="loading-card"><LoaderCircle size={28} /><strong>{label}</strong><span>This may take a moment.</span><div className="loading-bar"><i /></div></div></div>;
}

function GenerationProgress({ progress }: { progress: { percent: number; stage: string; detail: string } }) {
  const percent = Math.max(0, Math.min(100, progress.percent));
  return <div className="loading-overlay" role="status" aria-live="polite">
    <div className="loading-card generation-progress">
      <div className="progress-heading">
        <LoaderCircle className="spin" size={26} />
        <strong>{progress.stage}</strong>
        <b>{percent}%</b>
      </div>
      <span>{progress.detail || "Starting the local visual-planning engine…"}</span>
      <div className="loading-bar determinate"><i style={{ width: `${percent}%` }} /></div>
      <small>Keep Auto Gen Studio open while Whisper analyzes the narration.</small>
    </div>
  </div>;
}

function ProductionView() {
  const { stage } = useAppStore();
  return stage === "visual-plan" ? <VisualPlanView /> : <InputsView />;
}

type ImageSettings = {
  aspectRatio: string;
  shotType: string;
  cameraAngle: string;
  lighting: string;
  mood: string;
  composition: string;
  visualStyle: string;
  colorPalette: string;
  lensFeel: string;
  depthOfField: string;
  backgroundComplexity: string;
  subjectDistance: string;
  motionFeel: string;
  textureDetail: string;
  realismLevel: string;
  negativePromptStrength: string;
  referenceAdherence: string;
};
const defaultImageSettings: ImageSettings = { aspectRatio: "16:9", shotType: "Undefined", cameraAngle: "Undefined", lighting: "Undefined", mood: "Undefined", composition: "Undefined", visualStyle: "Undefined", colorPalette: "Undefined", lensFeel: "Undefined", depthOfField: "Undefined", backgroundComplexity: "Undefined", subjectDistance: "Undefined", motionFeel: "Undefined", textureDetail: "Undefined", realismLevel: "Undefined", negativePromptStrength: "Undefined", referenceAdherence: "Undefined" };
function parseImageSettings(value?: string): ImageSettings {
  try { return { ...defaultImageSettings, ...(value ? JSON.parse(value) : {}) }; }
  catch { return defaultImageSettings; }
}

function mergeExtractedSettings(current: ImageSettings, extracted: Partial<Record<string, string>>): ImageSettings {
  const aliases: Record<string, keyof ImageSettings> = {
    artStyle: "visualStyle", style: "visualStyle", lens: "lensFeel",
    colorGrade: "colorPalette", texture: "textureDetail",
  };
  const presets: Partial<Record<keyof ImageSettings, string[]>> = {
    shotType: ["Extreme close up","Close up","Medium shot","Wide shot","Establishing shot"],
    cameraAngle: ["Eye level","Low angle","High angle","Over the shoulder","Top down","Dutch angle"],
    lighting: ["Soft natural","Cinematic","Dramatic","Studio","Low key","High contrast"],
    mood: ["Calm","Tense","Emotional","Mysterious","Educational","Dramatic"],
    composition: ["Centered subject","Rule of thirds","Negative space","Thumbnail style","Symmetrical"],
    visualStyle: ["Near photorealistic illustration","Cinematic still","Editorial digital painting","Semi realistic animation","Natural history illustration"],
    colorPalette: ["Warm","Cool","Neutral","Muted","Pastel","High contrast"],
    lensFeel: ["Wide angle","Portrait lens","Telephoto compression","Macro"],
    depthOfField: ["Shallow","Medium","Deep"],
    backgroundComplexity: ["Plain","Minimal","Environmental","Detailed"],
    subjectDistance: ["Very close","Close","Medium","Far"],
    motionFeel: ["Static","Subtle motion","Dynamic action"],
    textureDetail: ["Soft","Detailed","Highly detailed"],
    realismLevel: ["Stylized","Semi realistic","Near photorealistic"],
    negativePromptStrength: ["Low","Medium","High"],
    referenceAdherence: ["Loose","Balanced","Strict"],
  };
  const next = { ...current };
  for (const [rawKey, rawValue] of Object.entries(extracted)) {
    const key = (aliases[rawKey] ?? rawKey) as keyof ImageSettings;
    if (!(key in next) || !rawValue?.trim()) continue;
    const value = rawValue.trim();
    const normalized = value.toLowerCase().replace(/[-_]/g, " ");
    const match = presets[key]?.find((preset) => {
      const candidate = preset.toLowerCase();
      return normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized);
    });
    next[key] = match ?? value;
  }
  return next;
}

function SettingSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const listId = `setting-${label.toLowerCase().replace(/\s+/g, "-")}`;
  const displayValue = value.startsWith("Custom: ") ? value.slice(8) : value === "Custom..." ? "" : value;
  return <label className="setting-control"><span>{label}</span><input list={listId} value={displayValue} placeholder={`Choose or type ${label.toLowerCase()}`} onChange={(event) => { const next = event.target.value; onChange(options.includes(next) ? next : `Custom: ${next}`); }} /><datalist id={listId}>{options.filter((option) => option !== "Custom...").map((option) => <option key={option} value={option} />)}</datalist></label>;
}

function ImagesView() {
  const { activeVideoId } = useAppStore();
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [activePromptVersionId, setActivePromptVersionId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [imageSettings, setImageSettings] = useState<ImageSettings>(defaultImageSettings);
  const settingsJson = JSON.stringify(imageSettings);
  const [geminiModel, setGeminiModel] = useState("gemini-3.1-flash-image");
  const [keyStatus, setKeyStatus] = useState({ gemini: false, openai: false });
  const [tab, setTab] = useState<"prompt" | "settings" | "edit">("prompt");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImageJobRecord | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [compareRenderId, setCompareRenderId] = useState<string | null>(null);
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [editInstruction, setEditInstruction] = useState("");
  const [editStrength, setEditStrength] = useState("Low");
  const [editOpen, setEditOpen] = useState(false);
  const [brushSize, setBrushSize] = useState(36);
  const [eraseMask, setEraseMask] = useState(false);
  const [editPanMode, setEditPanMode] = useState(false);
  const [editZoom, setEditZoom] = useState(1);
  const [editPan, setEditPan] = useState({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const paintingRef = useRef(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [references, setReferences] = useState<import("./infrastructure/projects-client").InputAssetRecord[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [visualStrategyMode, setVisualStrategyMode] = useState<import("./infrastructure/projects-client").VisualStrategyMode>("Auto Educational");
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [preparingGroupIds, setPreparingGroupIds] = useState<Set<string>>(new Set());
  const [promptPrepStatus, setPromptPrepStatus] = useState<"running" | "paused" | null>(null);
  const promptPrepControl = useRef<"running" | "paused" | "stopped">("stopped");
  const promptPrepTask = useRef<{ items: ImageWorkspaceRecord["groups"]; index: number } | null>(null);
  const [referenceUrl, setReferenceUrl] = useState("");
  const promptPrepSettingKey = activeVideoId ? `prompt_prep.${activeVideoId}` : "";

  const selectedGroup = useMemo(
    () => workspace?.groups.find((group) => group.group.id === selectedGroupId) ?? null,
    [workspace, selectedGroupId],
  );
  const selectedSentences = useMemo(
    () => selectedGroup?.group.sentenceIds
      .map((id) => workspace?.sentences.find((sentence) => sentence.id === id))
      .filter((sentence): sentence is PlanSentenceRecord => Boolean(sentence)) ?? [],
    [selectedGroup, workspace],
  );
  const selectedTiming = selectedSentences.length ? {
    start: selectedSentences[0].startSeconds,
    end: selectedSentences.at(-1)!.endSeconds,
  } : null;
  const educationalPlan = selectedGroup?.educationalPlan ?? null;

  useEffect(() => {
    async function loadWorkspace() {
      if (!activeVideoId) return;
      const cached = imageWorkspaceCache.get(activeVideoId);
      if (cached) {
        setWorkspace(cached);
        setSelectedGroupId((current) => current ?? cached.groups[0]?.group.id ?? null);
      }
      setLoading(!cached);
      setError(null);
      try {
        const loaded = await projectsClient.getImageWorkspace(activeVideoId);
        imageWorkspaceCache.set(activeVideoId, loaded);
        setWorkspace(loaded);
        setSelectedGroupId(loaded.groups[0]?.group.id ?? null);
        setImageSettings(parseImageSettings(loaded.settings.find((setting) => setting.key === "image_settings")?.value));
        setGeminiModel(loaded.settings.find((setting) => setting.key === "gemini_model")?.value ?? "gemini-3.1-flash-image");
        setVisualStrategyMode((loaded.settings.find((setting) => setting.key === "visual_strategy_mode")?.value as import("./infrastructure/projects-client").VisualStrategyMode) ?? "Auto Educational");
        const [geminiStatus, openAiStatus, inputs] = await Promise.all([
          projectsClient.getProviderKeyStatus("gemini"),
          projectsClient.getProviderKeyStatus("openai"),
          projectsClient.getVideoInputs(activeVideoId),
        ]);
        setKeyStatus({ gemini: geminiStatus.configured, openai: openAiStatus.configured });
        setReferences(inputs.references);
        const latestJob = await projectsClient.getLatestImageJob(activeVideoId);
        setJob(latestJob && ["queued", "running", "paused"].includes(latestJob.status) ? latestJob : null);
        const latest = loaded.groups[0]?.promptVersions[0];
        setActivePromptVersionId(latest?.id ?? null);
        setSystemPrompt(latest?.systemPrompt ?? "");
        setUserPrompt(latest?.userPrompt ?? "");
        const latestRender = loaded.groups[0]?.imageRenders[0];
        setSelectedRenderId(latestRender?.id ?? null);
        setCompareRenderId(latestRender?.parentRenderId ?? loaded.groups[0]?.imageRenders[1]?.id ?? null);
        const savedPrep = loaded.settings.find((setting) => setting.key === `prompt_prep.${activeVideoId}`)?.value;
        if (savedPrep) {
          try {
            const saved = JSON.parse(savedPrep) as { status: string; index: number; strategyMode: import("./infrastructure/projects-client").VisualStrategyMode; settings: ImageSettings; styleDirective: string };
            if (saved.status === "paused" && saved.index < loaded.groups.length) {
              setVisualStrategyMode(saved.strategyMode);
              setImageSettings(saved.settings);
              setSystemPrompt(saved.styleDirective);
              promptPrepTask.current = { items: loaded.groups, index: saved.index };
              promptPrepControl.current = "paused";
              setPromptPrepStatus("paused");
              setBulkProgress({ current: saved.index, total: loaded.groups.length, label: "Prompt preparation paused — ready to resume" });
              setPreparingGroupIds(new Set(loaded.groups.slice(saved.index).map((item) => item.group.id)));
            }
          } catch { /* Ignore malformed legacy preparation state. */ }
        }
      } catch (caught) {
        setError(String(caught));
      } finally {
        setLoading(false);
      }
    }
    void loadWorkspace();
  }, [activeVideoId]);

  useEffect(() => {
    if (!activeVideoId || !job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      const latest = await projectsClient.getLatestImageJob(activeVideoId);
      setJob(latest && ["queued", "running", "paused"].includes(latest.status) ? latest : null);
      const refreshed = await projectsClient.getImageWorkspace(activeVideoId);
      setWorkspace(refreshed);
      const selected = refreshed.groups.find((item) => item.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest && newest.id !== selectedRenderId) setSelectedRenderId(newest.id);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeVideoId, job, selectedGroupId, selectedRenderId]);

  async function refreshWorkspace() {
    if (!activeVideoId) return;
    try {
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      imageWorkspaceCache.set(activeVideoId, loaded);
      setWorkspace(loaded);
      const selected = loaded.groups.find((group) => group.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest) setSelectedRenderId(newest.id);
      setActivePromptVersionId((current) => {
        if (current && loaded.groups.some((group) => group.promptVersions.some((version) => version.id === current))) {
          return current;
        }
        return loaded.groups[0]?.promptVersions[0]?.id ?? null;
      });
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function createVersion() {
    if (!activeVideoId || !selectedGroupId) return;
    const latest = selectedGroup?.promptVersions[0];
    const style = systemPrompt || "Preserve a coherent visual style.";
    if (!userPrompt.trim() || (latest?.userPrompt === userPrompt && latest?.systemPrompt === style && latest?.settingsJson === settingsJson)) return;
    try {
      const version = await projectsClient.createPromptVersion(
        activeVideoId,
        selectedGroupId,
        settingsJson,
        style,
        userPrompt,
      );
      setActivePromptVersionId(version.id);
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function generateRender() {
    if (!activeVideoId || !selectedGroupId) return;
    setLoading(true);
    setError(null);
    try {
      const versionId = (
        await projectsClient.createPromptVersion(
          activeVideoId,
          selectedGroupId,
          settingsJson,
          systemPrompt || "Preserve a coherent visual style.",
          userPrompt,
        )
      ).id;
      const render = await projectsClient.generateImageRender(
        activeVideoId,
        selectedGroupId,
        versionId,
        systemPrompt || "Preserve a coherent visual style.",
        userPrompt,
        settingsJson,
      );
      setSelectedRenderId(render.id);
      setRenderUrls((current) => {
        const next = { ...current };
        delete next[render.id];
        return next;
      });
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function controlJob(action: "pause" | "resume" | "stop") {
    if (!job) return;
    try {
      setJob(await projectsClient.controlImageJob(job.id, action));
    } catch (caught) {
      setError(String(caught));
    }
  }

  function selectVersion(version: PromptVersionRecord) {
    setActivePromptVersionId(version.id);
    setSystemPrompt(version.systemPrompt);
    setUserPrompt(version.userPrompt);
    setImageSettings(parseImageSettings(version.settingsJson));
  }

  function selectGroup(groupId: string) {
    setSelectedGroupId(groupId);
    const latest = workspace?.groups.find((item) => item.group.id === groupId)?.promptVersions[0];
    setActivePromptVersionId(latest?.id ?? null);
    setSystemPrompt(latest?.systemPrompt ?? "");
    setUserPrompt(latest?.userPrompt ?? "");
    setImageSettings(parseImageSettings(latest?.settingsJson));
    const latestRender = workspace?.groups.find((item) => item.group.id === groupId)?.imageRenders[0];
    setSelectedRenderId(latestRender?.id ?? null);
    setCompareRenderId(latestRender?.parentRenderId ?? null);
  }

  async function saveSettings() {
    if (!activeVideoId || !selectedGroupId) return;
    setLoading(true);
    setError(null);
    try {
      await projectsClient.saveAppSetting("image_settings", settingsJson);
      await projectsClient.saveAppSetting("gemini_model", geminiModel.trim());
      if (userPrompt.trim()) {
        const version = await projectsClient.createPromptVersion(activeVideoId, selectedGroupId, settingsJson, systemPrompt || "Preserve a coherent visual style.", userPrompt);
        setActivePromptVersionId(version.id);
      }
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function runPromptPreparation() {
    if (!activeVideoId || !promptPrepTask.current) return;
    promptPrepControl.current = "running";
    setPromptPrepStatus("running");
    const task = promptPrepTask.current;
    try {
      for (; task.index < task.items.length; task.index++) {
        if (promptPrepControl.current !== "running") break;
        const index = task.index;
        const item = task.items[index];
        setBulkProgress({ current: index, total: task.items.length, label: `Planning Still ${item.group.ordinal}` });
        const planned = await projectsClient.planEducationalVisual(
          activeVideoId, item.group.id, settingsJson, systemPrompt,
        );
        if (promptPrepControl.current !== "running") break;
        const perStill = mergeExtractedSettings(imageSettings, planned.imageSettings);
        const perStillJson = JSON.stringify({ ...perStill, _educationalPlanSignature: planned.planSignature });
        const latest = item.promptVersions[0];
        const latestMeta = (() => { try { return JSON.parse(latest?.settingsJson ?? "{}") as { _educationalPlanSignature?: string }; } catch { return {}; } })();
        if (latestMeta._educationalPlanSignature !== planned.planSignature) {
          const savedVersion = await projectsClient.createPromptVersion(activeVideoId, item.group.id, perStillJson, systemPrompt || "Preserve a coherent visual style.", planned.userPrompt);
          if (item.group.id === selectedGroupId) {
            setImageSettings(perStill);
            setUserPrompt(planned.userPrompt);
            setActivePromptVersionId(savedVersion.id);
          }
        }
        const live = await projectsClient.getImageWorkspace(activeVideoId);
        imageWorkspaceCache.set(activeVideoId, live);
        setWorkspace(live);
        if (item.group.id === selectedGroupId) {
          const livePrompt = live.groups.find((group) => group.group.id === item.group.id)?.promptVersions[0];
          if (livePrompt) {
            setImageSettings(parseImageSettings(livePrompt.settingsJson));
            setUserPrompt(livePrompt.userPrompt);
          }
        }
        setPreparingGroupIds((current) => {
          const next = new Set(current);
          next.delete(item.group.id);
          return next;
        });
        setBulkProgress({ current: index + 1, total: task.items.length, label: `Prompt ready for Still ${item.group.ordinal}` });
        if (promptPrepSettingKey) await projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
          status: "running", index: index + 1, strategyMode: visualStrategyMode,
          settings: imageSettings, styleDirective: systemPrompt,
        }));
      }
      const finalControl = promptPrepControl.current as "running" | "paused" | "stopped";
      if (finalControl === "running" && task.index >= task.items.length) {
        setBulkProgress({ current: task.items.length, total: task.items.length, label: "Starting image generation" });
        setJob(await projectsClient.createImageJob(activeVideoId));
        promptPrepTask.current = null;
        promptPrepControl.current = "stopped";
        setPromptPrepStatus(null);
        setBulkProgress(null);
        setPreparingGroupIds(new Set());
        if (promptPrepSettingKey) await projectsClient.saveAppSetting(promptPrepSettingKey, "");
      } else if (finalControl === "paused") {
        setPromptPrepStatus("paused");
        if (promptPrepSettingKey) await projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
          status: "paused", index: task.index, strategyMode: visualStrategyMode,
          settings: imageSettings, styleDirective: systemPrompt,
        }));
      } else if (finalControl === "stopped") {
        setPromptPrepStatus(null);
        setBulkProgress(null);
        setPreparingGroupIds(new Set());
        promptPrepTask.current = null;
        if (promptPrepSettingKey) await projectsClient.saveAppSetting(promptPrepSettingKey, "");
      }
    } catch (caught) {
      setError(String(caught));
      promptPrepControl.current = "paused";
      setPromptPrepStatus("paused");
      if (promptPrepSettingKey && promptPrepTask.current) await projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
        status: "paused", index: promptPrepTask.current.index, strategyMode: visualStrategyMode,
        settings: imageSettings, styleDirective: systemPrompt,
      }));
    }
  }

  async function prepareBulkPrompts() {
    if (!activeVideoId || !workspace) return;
    setError(null);
    await projectsClient.saveAppSetting("image_settings", settingsJson);
    await projectsClient.saveAppSetting("gemini_model", "gemini-3.1-flash-image");
    await projectsClient.saveAppSetting("visual_strategy_mode", visualStrategyMode);
    setBulkOpen(false);
    setJob(null);
    setPreparingGroupIds(new Set(workspace.groups.map((item) => item.group.id)));
    setBulkProgress({ current: 0, total: workspace.groups.length, label: "Preparing prompts" });
    promptPrepTask.current = { items: workspace.groups, index: 0 };
    if (promptPrepSettingKey) await projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
      status: "running", index: 0, strategyMode: visualStrategyMode,
      settings: imageSettings, styleDirective: systemPrompt,
    }));
    await runPromptPreparation();
  }

  function controlPromptPreparation(action: "pause" | "resume" | "stop") {
    if (action === "pause") {
      promptPrepControl.current = "paused";
      setPromptPrepStatus("paused");
      if (promptPrepSettingKey && promptPrepTask.current) void projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
        status: "paused", index: promptPrepTask.current.index, strategyMode: visualStrategyMode,
        settings: imageSettings, styleDirective: systemPrompt,
      }));
    } else if (action === "stop") {
      promptPrepControl.current = "stopped";
      setPromptPrepStatus(null);
      setBulkProgress(null);
      setPreparingGroupIds(new Set());
      if (promptPrepSettingKey) void projectsClient.saveAppSetting(promptPrepSettingKey, "");
    } else if (promptPrepTask.current) {
      void runPromptPreparation();
    }
  }

  async function suggestPrompt() {
    if (!activeVideoId || !selectedGroupId) return;
    setLoading(true);
    setError(null);
    try {
      const whole = await projectsClient.planWholeVideoEducationalVisuals(activeVideoId, settingsJson, systemPrompt, visualStrategyMode);
      const planned = whole.plans.find((item) => item.visualPlanRowId === selectedGroupId);
      if (!planned) throw new Error("The whole-video plan did not include the selected still.");
      setUserPrompt(planned.userPrompt);
      setImageSettings((current) => mergeExtractedSettings(current, planned.imageSettings));
      await refreshWorkspace();
    } catch (caught) { setError(String(caught)); }
    finally { setLoading(false); }
  }

  function updateImageSetting<K extends keyof ImageSettings>(key: K, value: ImageSettings[K]) {
    setImageSettings((current) => ({ ...current, [key]: value }));
  }

  async function importReference() {
    if (!activeVideoId) return;
    if (references.length) await removeReference(references[0].id);
    const asset = await projectsClient.pickAndImportAsset(activeVideoId, "reference");
    if (asset) {
      setReferences([asset]);
      setReferenceUrl(await projectsClient.getAssetDataUrl(asset.id));
    }
  }

  useEffect(() => {
    const reference = references[0];
    if (!reference) return;
    void projectsClient.getAssetDataUrl(reference.id).then(setReferenceUrl).catch(() => setReferenceUrl(""));
  }, [references]);

  async function removeReference(assetId: string) {
    await projectsClient.removeInputAsset(assetId);
    setReferences((items) => items.filter((item) => item.id !== assetId));
    setReferenceUrl("");
  }

  async function extractStyle(assetId: string) {
    setLoading(true);
    setError(null);
    try {
      const extracted = await projectsClient.extractReferenceStyle(assetId);
      setSystemPrompt(extracted.styleDirective);
      setImageSettings((current) => mergeExtractedSettings(current, extracted.imageSettings));
      setTab("settings");
    } catch (caught) { setError(String(caught)); }
    finally { setLoading(false); }
  }

  const previewLabel = selectedGroup?.group.label ?? "Still preview";
  const stillCount = workspace?.groups.length ?? 0;
  const promptVersions = selectedGroup?.promptVersions ?? [];
  const imageRenders = selectedGroup?.imageRenders ?? [];

  useEffect(() => {
    const ids = [selectedRenderId, compareRenderId].filter(Boolean) as string[];
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await projectsClient.getRenderDataUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [selectedRenderId, compareRenderId, renderUrls]);

  useEffect(() => {
    const ids = workspace?.groups.map((group) => group.imageRenders[0]?.id).filter(Boolean) as string[] | undefined;
    if (!ids?.length) return;
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await projectsClient.getRenderDataUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [workspace, renderUrls]);

  async function editSelectedRender() {
    if (!selectedRenderId || !editInstruction.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const canvas = maskCanvasRef.current;
      const maskDataUrl = canvas && canvas.dataset.painted === "true" ? canvas.toDataURL("image/png") : undefined;
      const edited = await projectsClient.editImageRender(selectedRenderId, editInstruction.trim(), maskDataUrl, editStrength);
      setCompareRenderId(selectedRenderId);
      setSelectedRenderId(edited.id);
      setEditInstruction("");
      setEditOpen(false);
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  function selectRender(render: ImageRenderRecord) {
    setCompareRenderId(render.parentRenderId ?? selectedRenderId);
    setSelectedRenderId(render.id);
  }

  function paintMask(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!paintingRef.current) return;
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.globalCompositeOperation = eraseMask ? "destination-out" : "source-over";
    context.fillStyle = "#fff";
    context.beginPath();
    context.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    context.fill();
    canvas.dataset.painted = "true";
  }

  function clearMask() {
    const canvas = maskCanvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (canvas) canvas.dataset.painted = "false";
  }

  async function toggleFinal(render: ImageRenderRecord) {
    try {
      await projectsClient.setFinalRender(render.id, !render.isFinal);
      await refreshWorkspace();
    } catch (caught) { setError(String(caught)); }
  }

  async function deletePromptVersion(version: PromptVersionRecord) {
    try {
      await projectsClient.deletePromptVersion(version.id);
      if (activePromptVersionId === version.id) setActivePromptVersionId(null);
      await refreshWorkspace();
    } catch (caught) { setError(String(caught)); }
  }

  async function deleteRender(render: ImageRenderRecord) {
    try {
      await projectsClient.deleteImageRender(render.id);
      setRenderUrls((current) => {
        const next = { ...current };
        delete next[render.id];
        return next;
      });
      if (selectedRenderId === render.id) setSelectedRenderId(null);
      await refreshWorkspace();
    } catch (caught) { setError(String(caught)); }
  }

  async function resetImages() {
    if (!activeVideoId || !window.confirm("Clear all image prompts, image versions, planner results, and still statuses for this video? This cannot be undone.")) return;
    setLoading(true);
    setError(null);
    try {
      if (job && ["queued", "running", "paused"].includes(job.status)) {
        await projectsClient.controlImageJob(job.id, "stop");
      }
      promptPrepControl.current = "stopped";
      await projectsClient.resetImageWorkflow(activeVideoId);
      imageWorkspaceCache.delete(activeVideoId);
      setJob(null);
      setBulkProgress(null);
      setPromptPrepStatus(null);
      setPreparingGroupIds(new Set());
      setRenderUrls({});
      setSelectedRenderId(null);
      setActivePromptVersionId(null);
      setUserPrompt("");
      setSystemPrompt("");
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      imageWorkspaceCache.set(activeVideoId, loaded);
      setWorkspace(loaded);
      setSelectedGroupId(loaded.groups[0]?.group.id ?? null);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  function moveVersion(delta: number) {
    const index = imageRenders.findIndex((render) => render.id === selectedRenderId);
    const next = imageRenders[index + delta];
    if (next) selectRender(next);
  }

  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomOpen(false);
      if (event.key === "+") setZoom((value) => Math.min(5, value + .25));
      if (event.key === "-") setZoom((value) => Math.max(.25, value - .25));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomOpen]);

  async function exportStills() {
    if (!activeVideoId) return;
    try {
      const result = await projectsClient.exportLatestStills(activeVideoId);
      if (result) setError(`Exported ${result.fileCount} stills to ${result.path}`);
    } catch (caught) { setError(String(caught)); }
  }

  async function exportBundle() {
    if (!activeVideoId) return;
    try {
      const result = await projectsClient.exportProjectBundle(activeVideoId);
      if (result) setError(`Project bundle saved to ${result.path}`);
    } catch (caught) { setError(String(caught)); }
  }

  return (
    <section className="view images-view">
      {loading && <LoadingOverlay label="Working on your images" />}
      <div className="page-heading">
        <div>
          <p className="eyebrow">Stage 3 of 3</p>
          <h1>Image generation</h1>
          <p>Select a still, review prompt versions, and generate render outputs.</p>
        </div>
        <div className="heading-actions"><button className="secondary danger-action" onClick={() => void resetImages()} disabled={loading}><Trash2 size={16} />Reset Images</button><button className="secondary" onClick={() => void exportStills()}><Download size={16} />Final output folder</button><button className="secondary" onClick={() => void exportBundle()}><Download size={16} />Project bundle</button><button className="primary" onClick={() => setBulkOpen(true)} disabled={!workspace?.groups.length || loading || Boolean(job && ["queued", "running", "paused"].includes(job.status))}><WandSparkles size={17} />Bulk Gen Config</button></div>
      </div>
      {error && <div className="error-toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
      {job && !bulkProgress && (
        <div className="job-status">
          <div><strong>Bulk job: {job.status}</strong><span>{job.completedItems}/{job.totalItems} completed · {job.failedItems} failed</span></div>
          <progress value={job.completedItems + job.failedItems} max={job.totalItems} />
          <div>
            {["queued", "running"].includes(job.status) && <button className="secondary" onClick={() => void controlJob("pause")}>Pause</button>}
            {job.status === "paused" && <button className="secondary" onClick={() => void controlJob("resume")}>Resume</button>}
            {["queued", "running", "paused"].includes(job.status) && <button className="secondary" onClick={() => void controlJob("stop")}>Stop</button>}
          </div>
        </div>
      )}
      {bulkProgress && <div className="bulk-live-progress"><div><strong>{bulkProgress.label}</strong><span>{bulkProgress.current} / {bulkProgress.total}</span></div><progress value={bulkProgress.current} max={bulkProgress.total} /><div className="prompt-progress-actions">{promptPrepStatus === "running" && <button className="secondary" onClick={() => controlPromptPreparation("pause")}>Pause</button>}{promptPrepStatus === "paused" && <button className="secondary" onClick={() => controlPromptPreparation("resume")}>Resume</button>}<button className="secondary" onClick={() => controlPromptPreparation("stop")}>Stop</button></div></div>}
      <div className="image-workspace">
        <aside className="stills">
          <strong>Stills <span>{stillCount}</span></strong>
          {workspace?.groups.map((group) => (
            <button
              key={group.group.id}
              className={group.group.id === selectedGroupId ? "active" : ""}
              onClick={() => selectGroup(group.group.id)}
            >
              <div><strong>Still {group.group.ordinal}</strong>{group.imageRenders.length > 0 && <Check size={14} />}</div>
              <small>{(() => { const rows = group.group.sentenceIds.map((id) => workspace.sentences.find((s) => s.id === id)).filter(Boolean) as PlanSentenceRecord[]; return rows.length ? `${formatTime(rows[0].startSeconds)} – ${formatTime(rows.at(-1)!.endSeconds)}` : ""; })()}</small>
              <p>{group.group.sentenceIds.map((id) => workspace.sentences.find((s) => s.id === id)?.text).filter(Boolean).join(" ").slice(0, 72)}</p>
              {(() => { const item = job?.items.find((candidate) => candidate.groupId === group.group.id); const newestPrompt = group.promptVersions[0]; const newestRender = group.imageRenders[0]; const status = preparingGroupIds.has(group.group.id) ? "Preparing prompt" : item?.status === "running" ? "Generating" : item?.status === "failed" ? "Failed" : newestRender && newestPrompt && newestRender.promptVersionId !== newestPrompt.id ? "Outdated" : newestRender ? "Generated" : newestPrompt ? "Prompt ready" : "No prompt"; return <span className={`still-status ${status.toLowerCase().replace(" ","-")}`}>{status}</span>; })()}
            </button>
          ))}
          {!workspace && <div className="empty-state">Loading stills…</div>}
        </aside>
        <div className="preview">
          <header>
            <div><span className="timestamp-heading">{selectedTiming ? `${formatTime(selectedTiming.start)} – ${formatTime(selectedTiming.end)}` : previewLabel}</span><strong className="production-copy">{selectedSentences.map((sentence) => sentence.text).join(" ")}</strong></div>
          </header>
          <div className="preview-art">
            {selectedRenderId && renderUrls[selectedRenderId] ? (
              <figure className={`image-frame ${imageSettings.aspectRatio === "9:16" ? "portrait" : "landscape"}`}><img src={renderUrls[selectedRenderId]} alt="Selected image version" /><button className="inspect-button" onClick={() => { setZoom(1); setZoomOpen(true); }}><Maximize2 size={16} /><span>Inspect</span></button></figure>
            ) : <div className={`image-frame empty-frame ${imageSettings.aspectRatio === "9:16" ? "portrait" : "landscape"}`}><div className="image-empty"><Image size={34} /><strong>No image generated yet</strong><span>{imageSettings.aspectRatio === "9:16" ? "YouTube Short · 9:16" : "YouTube Video · 16:9"}</span></div></div>}
          </div>
          <footer>
            <div className="version-nav"><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) >= imageRenders.length - 1} onClick={() => moveVersion(1)}><ChevronLeft size={16} />Previous</button><strong>{selectedRenderId ? `Version ${imageRenders.find((r) => r.id === selectedRenderId)?.version} / ${imageRenders.length}` : "No versions"}</strong><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) <= 0} onClick={() => moveVersion(-1)}>Next<ChevronRight size={16} /></button></div>
            {imageRenders.find((render) => render.id === selectedRenderId) && <div className="version-actions"><button className="secondary" onClick={() => void toggleFinal(imageRenders.find((render) => render.id === selectedRenderId)!)}>{imageRenders.find((render) => render.id === selectedRenderId)?.isFinal ? "Unmark Final" : "Mark as Final"}</button><button className="secondary" onClick={() => { const render = imageRenders.find((item) => item.id === selectedRenderId); const version = promptVersions.find((item) => item.id === render?.promptVersionId); if (version) selectVersion(version); }}>Roll Back To This Version</button></div>}
          </footer>
        </div>
        <aside className="prompt-panel">
          <div className="tabs">
            <button className={tab === "prompt" ? "active" : ""} onClick={() => setTab("prompt")}>Prompt</button>
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
            <button className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>Edit / Inpaint</button>
          </div>
          {tab === "prompt" ? (
            <>
              <div className="panel-section-heading"><h3>Scene prompt</h3><small>Still {selectedGroup?.group.ordinal ?? "—"}</small></div>
              {educationalPlan && <div className="educational-plan-card">
                <div><span>Educational objective</span><strong>{educationalPlan.educationalObjective}</strong></div>
                <div><span>Visual intent</span><strong>{educationalPlan.visualIntent}</strong></div>
                <div><span>Subject strategy</span><strong>{educationalPlan.subjectStrategy}</strong></div>
              </div>}
              <label>
                <span className="field-heading">User prompt</span>
                <textarea className="production-copy"
                  value={userPrompt}
                  onChange={(event) => setUserPrompt(event.target.value)}
                  onBlur={() => void createVersion()}
                  placeholder="Describe the scene that directly supports this narration."
                />
              </label>
              <button className="secondary full" onClick={() => void suggestPrompt()} disabled={!selectedGroupId || loading || !keyStatus.openai}><Sparkles size={15} />Suggest Prompt</button>
              <label>
                <span className="field-heading">Style Directive <small>Optional</small></span>
                <textarea className="production-copy"
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  onBlur={() => void createVersion()}
                  placeholder="Reusable visual style, medium, rendering, and color treatment."
                />
              </label>
              <button className="primary full" onClick={() => void generateRender()} disabled={!selectedGroupId || !userPrompt.trim() || loading}>Generate Image</button>
              {promptVersions.length > 0 && (
                <div className="version-history"><strong>Prompt versions</strong>
                  {promptVersions.slice(0, 5).map((version) => (
                    <div className="version-row" key={version.id}><button className={version.id === activePromptVersionId ? "active" : ""} onClick={() => selectVersion(version)}><span>v{version.version}</span><small>{new Date(version.createdAt).toLocaleString()}</small></button><button className="delete-version" onClick={() => void deletePromptVersion(version)} title="Delete prompt version"><Trash2 size={14} /></button></div>
                  ))}
                </div>
              )}
              {imageRenders.length > 0 && <div className="version-history"><strong>Image versions</strong>{imageRenders.slice(0, 5).map((render) => (
                <div className="version-row" key={render.id}>
                  <button type="button" className={render.id === selectedRenderId ? "active" : ""} onClick={() => selectRender(render)}>
                    <span>Version {render.version} · {render.kind}{render.isFinal ? " · Final" : ""}</span>
                    <small>{render.editInstruction ?? new Date(render.createdAt).toLocaleString()}</small>
                  </button>
                  <button className="delete-version" onClick={() => void deleteRender(render)} title="Delete image version"><Trash2 size={14} /></button>
                </div>
              ))}</div>}
            </>
          ) : tab === "settings" ? (
            <>
              <div className="panel-section-heading"><h3>Image settings</h3><small>Saved per still</small></div>
              <div className="setting-grid">
                <SettingSelect label="Aspect ratio" value={imageSettings.aspectRatio} options={["16:9","9:16"]} onChange={(value) => updateImageSetting("aspectRatio", value)} />
                <SettingSelect label="Shot type" value={imageSettings.shotType} options={["Undefined","Extreme close up","Close up","Medium shot","Wide shot","Establishing shot","Custom..."]} onChange={(value) => updateImageSetting("shotType", value)} />
                <SettingSelect label="Camera angle" value={imageSettings.cameraAngle} options={["Undefined","Eye level","Low angle","High angle","Over the shoulder","Top down","Dutch angle","Custom..."]} onChange={(value) => updateImageSetting("cameraAngle", value)} />
                <SettingSelect label="Lighting" value={imageSettings.lighting} options={["Undefined","Soft natural","Cinematic","Dramatic","Studio","Low key","High contrast","Custom..."]} onChange={(value) => updateImageSetting("lighting", value)} />
                <SettingSelect label="Mood" value={imageSettings.mood} options={["Undefined","Calm","Tense","Emotional","Mysterious","Educational","Dramatic","Custom..."]} onChange={(value) => updateImageSetting("mood", value)} />
                <SettingSelect label="Composition" value={imageSettings.composition} options={["Undefined","Centered subject","Rule of thirds","Negative space","Thumbnail style","Symmetrical","Custom..."]} onChange={(value) => updateImageSetting("composition", value)} />
                <SettingSelect label="Visual style" value={imageSettings.visualStyle} options={["Undefined","Near photorealistic illustration","Cinematic still","Editorial digital painting","Semi realistic animation","Natural history illustration","Custom..."]} onChange={(value) => updateImageSetting("visualStyle", value)} />
                <SettingSelect label="Color palette" value={imageSettings.colorPalette} options={["Undefined","Warm","Cool","Neutral","Muted","Pastel","High contrast","Custom..."]} onChange={(value) => updateImageSetting("colorPalette", value)} />
              </div>
              <details className="advanced-settings"><summary><span><strong>Advanced settings</strong><small>Fine-tune camera and rendering</small></span><b>＋</b></summary><div className="setting-grid">
                {([
                  ["lensFeel","Lens feel",["Undefined","Wide angle","Portrait lens","Telephoto compression","Macro","Custom..."]],
                  ["depthOfField","Depth of field",["Undefined","Shallow","Medium","Deep","Custom..."]],
                  ["backgroundComplexity","Background complexity",["Undefined","Plain","Minimal","Environmental","Detailed","Custom..."]],
                  ["subjectDistance","Subject distance",["Undefined","Very close","Close","Medium","Far","Custom..."]],
                  ["motionFeel","Motion feel",["Undefined","Static","Subtle motion","Dynamic action","Custom..."]],
                  ["textureDetail","Texture detail",["Undefined","Soft","Detailed","Highly detailed","Custom..."]],
                  ["realismLevel","Realism level",["Undefined","Stylized","Semi realistic","Near photorealistic","Custom..."]],
                  ["negativePromptStrength","Negative prompt strength",["Undefined","Low","Medium","High","Custom..."]],
                  ["referenceAdherence","Reference adherence",["Undefined","Loose","Balanced","Strict","Custom..."]],
                ] as [keyof ImageSettings,string,string[]][]).map(([key,label,options]) => <SettingSelect key={key} label={label} value={imageSettings[key]} options={options} onChange={(value) => updateImageSetting(key, value)} />)}
              </div></details>
              <label className="model-setting"><span>Image model</span><select value={geminiModel} onChange={(event) => setGeminiModel(event.target.value)}><option value="gemini-3.1-flash-image">Gemini Nano Banana 2</option></select></label>
              <div className={keyStatus.gemini ? "provider-status ready" : "provider-status"}>
                <strong>Generation service</strong><span>{keyStatus.gemini ? "Configured securely in Windows Credential Manager" : "Not configured. Add the Gemini credential on the backend."}</span>
              </div>
              <div className="reference-manager">
                <div><strong>Visual references</strong><span>Optional style or subject guidance for image work.</span></div>
                {!references.length && <button className="secondary" onClick={() => void importReference()}><Plus size={14} />Add image</button>}
                {references.map((reference) => <div className="reference-item" key={reference.id}>{referenceUrl ? <img src={referenceUrl} alt="Visual reference" /> : <span>IMG</span>}<button title="Extract Style" onClick={() => void extractStyle(reference.id)}><Sparkles size={13} />Extract Style</button><button onClick={() => void removeReference(reference.id)} aria-label={`Remove ${reference.originalName}`}><X size={13} /></button></div>)}
              </div>
              <button className="primary full" onClick={() => void saveSettings()} disabled={loading}>Apply settings</button>
            </>
          ) : (
            <div className="edit-panel">
              <h3>Edit existing image</h3>
              <p>The actual selected image is sent back to Gemini. Paint a mask for localized changes.</p>
              <button className="primary full" onClick={() => { clearMask(); setEditOpen(true); }} disabled={!selectedRenderId}>Edit / Inpaint</button>
            </div>
          )}
        </aside>
      </div>
      {zoomOpen && selectedRenderId && renderUrls[selectedRenderId] && <div className="modal-backdrop image-lightbox" onClick={() => setZoomOpen(false)}>
        <div className="lightbox-shell" onClick={(event) => event.stopPropagation()}>
          <div className="lightbox-toolbar"><strong>Image inspection</strong><button onClick={() => setZoom((value) => Math.max(.25, value - .25))}><ZoomOut size={17} /></button><button onClick={() => setZoom(1)}>Reset</button><button onClick={() => setZoom((value) => Math.min(5, value + .25))}><ZoomIn size={17} /></button><button onClick={() => { setZoom(1); }}>Fit</button><button onClick={() => setZoomOpen(false)}><X size={17} /></button></div>
          <div className="lightbox-canvas"><img src={renderUrls[selectedRenderId]} alt="Zoomed selected version" style={{ transform: `scale(${zoom})` }} /></div>
        </div>
      </div>}
      {editOpen && selectedRenderId && renderUrls[selectedRenderId] && <div className="modal-backdrop image-lightbox">
        <div className="edit-modal">
          <div className="lightbox-toolbar"><strong>Edit / Inpaint</strong><button className={eraseMask && !editPanMode ? "active" : ""} onClick={() => { setEraseMask((current) => !current); setEditPanMode(false); }}>{eraseMask ? "Paint mask" : "Erase mask"}</button><button className={editPanMode ? "active" : ""} onClick={() => setEditPanMode((current) => !current)}>Pan</button><button onClick={() => setEditZoom((value) => Math.max(.5, value - .25))}><ZoomOut size={16} /></button><button onClick={() => { setEditZoom(1); setEditPan({ x: 0, y: 0 }); }}>Fit</button><button onClick={() => setEditZoom((value) => Math.min(4, value + .25))}><ZoomIn size={16} /></button><button onClick={clearMask}>Clear mask</button><button onClick={() => setEditOpen(false)}><X size={17} /></button></div>
          <div className="edit-body">
            <div className={editPanMode ? "mask-stage panning" : "mask-stage"} onPointerDown={(event) => { if (editPanMode) panStartRef.current = { x: event.clientX, y: event.clientY, originX: editPan.x, originY: editPan.y }; }} onPointerMove={(event) => { const start = panStartRef.current; if (editPanMode && start) setEditPan({ x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y }); }} onPointerUp={() => { panStartRef.current = null; }}>
              <div className={`mask-transform ${imageSettings.aspectRatio === "9:16" ? "portrait" : ""}`} style={{ transform: `translate(${editPan.x}px, ${editPan.y}px) scale(${editZoom})` }}>
                <img src={renderUrls[selectedRenderId]} alt="Source image for editing" />
                <canvas ref={maskCanvasRef} width={imageSettings.aspectRatio === "9:16" ? 720 : 1280} height={imageSettings.aspectRatio === "9:16" ? 1280 : 720} onPointerDown={(event) => { if (editPanMode) return; paintingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); paintMask(event); }} onPointerMove={(event) => { if (!editPanMode) paintMask(event); }} onPointerUp={() => { paintingRef.current = false; }} />
              </div>
            </div>
            <aside>
              <p>Paint only the area you want changed. Gemini receives the source image, mask image, and instruction together. Its API does not expose a dedicated mask parameter, so preservation is enforced through visual context and strict edit rules.</p>
              <label>Brush size<input type="range" min="8" max="140" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /></label>
              <button className="secondary full clear-mask-action" type="button" onClick={clearMask}>Clear painted mask</button>
              <label>Edit instruction<textarea value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} placeholder="Describe the exact localized change." /></label>
              <label>Edit Strength<select value={editStrength} onChange={(event) => setEditStrength(event.target.value)}><option>Low</option><option>Medium</option><option>High</option></select></label>
              <button className="primary full" onClick={() => void editSelectedRender()} disabled={!editInstruction.trim() || loading}>Apply Edit</button>
              <button className="secondary full" onClick={() => setEditOpen(false)}>Cancel</button>
            </aside>
          </div>
        </div>
      </div>}
      {bulkOpen && <div className="modal-backdrop">
        <div className="modal bulk-modal">
          <h2>Bulk Gen Config</h2>
          <>
            <label>Style Directive<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} /></label>
            <div className="reference-manager"><button className="secondary" onClick={() => void importReference()}>Upload reference image</button>{references.map((reference) => <button className="secondary" key={reference.id} onClick={() => void extractStyle(reference.id)}><Sparkles size={14} />Extract Style · {reference.originalName}</button>)}</div>
            <label className="strategy-mode-control"><span>Visual Strategy Mode</span><select value={visualStrategyMode} onChange={(event) => setVisualStrategyMode(event.target.value as import("./infrastructure/projects-client").VisualStrategyMode)}><option value="Auto Educational">Auto · Educational</option><option>Storytelling</option><option>Documentary</option><option>Scientific</option><option>Infographic Heavy</option></select><small>AI chooses visual types based on educational purpose while maintaining consistent style.</small></label>
            <div className="planner-explainer"><strong>Educational Visual Planner</strong><span>Each still is planned by teaching objective, visual intent, and subject strategy. Camera settings are chosen afterward to support the lesson.</span></div>
            <button className="primary full" onClick={() => void prepareBulkPrompts()}>Plan Visuals & Generate Prompts</button>
          </>
          <button className="secondary full" onClick={() => setBulkOpen(false)}>Cancel</button>
        </div>
      </div>}
    </section>
  );
}

function TimelineView() {
  const { activeVideoId } = useAppStore();
  const [timeline, setTimeline] = useState<TimelineRecord | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeVideoId) return;
    projectsClient.getTimeline(activeVideoId).catch(() => projectsClient.buildTimeline(activeVideoId))
      .then(setTimeline).catch((caught) => setError(String(caught)));
  }, [activeVideoId]);

  async function rebuild() {
    if (!activeVideoId) return;
    try { setTimeline(await projectsClient.buildTimeline(activeVideoId)); } catch (caught) { setError(String(caught)); }
  }

  async function updateView(playhead: number, zoom: number) {
    if (!activeVideoId) return;
    setTimeline(await projectsClient.updateTimelineView(activeVideoId, playhead, zoom));
  }

  async function nudgeBoundary(edge: "start" | "end", delta: number) {
    if (!activeVideoId || !timeline || !selectedClipId) return;
    const clip = timeline.clips.find((item) => item.id === selectedClipId);
    if (!clip) return;
    try {
      setTimeline(await projectsClient.updateTimelineClip(
        activeVideoId, clip.id,
        edge === "start" ? clip.startSeconds + delta : clip.startSeconds,
        edge === "end" ? clip.endSeconds + delta : clip.endSeconds,
      ));
    } catch (caught) { setError(String(caught)); }
  }

  const timelineReleased = false;
  if (!timelineReleased) {
    return <section className="view"><div className="coming-soon"><PanelsTopLeft size={34} /><p className="eyebrow">In production</p><h1>Timeline is coming soon</h1><p>Timeline editing is being refined and is not available in this build.</p></div></section>;
  }

  return (
    <section className="view">
      <div className="page-heading"><div><p className="eyebrow">Editor foundation</p><h1>Timeline</h1><p>Arrange approved stills against narration timing.</p></div><button className="secondary" onClick={() => void rebuild()}><Undo2 size={16} />Reset from visual plan</button></div>
      {error && <div className="inline-error">{error}</div>}
      {!timeline ? <div className="empty-state">Building timeline…</div> : (
        <div className="timeline-editor">
          <div className="timeline-toolbar">
            <label>Playhead <input type="range" min="0" max={timeline.durationSeconds} step=".1" value={timeline.playheadSeconds} onChange={(event) => void updateView(Number(event.target.value), timeline.zoom)} /></label>
            <label>Zoom <input type="range" min=".5" max="4" step=".25" value={timeline.zoom} onChange={(event) => void updateView(timeline.playheadSeconds, Number(event.target.value))} /></label>
            <span>{formatTime(timeline.playheadSeconds)} / {formatTime(timeline.durationSeconds)}</span>
          </div>
          <div className="timeline-track" style={{ width: `${Math.max(100, timeline.zoom * 100)}%` }}>
            <i className="playhead" style={{ left: `${timeline.durationSeconds ? timeline.playheadSeconds / timeline.durationSeconds * 100 : 0}%` }} />
            {timeline.clips.map((clip) => (
              <button key={clip.id} className={clip.id === selectedClipId ? "timeline-clip active" : "timeline-clip"} style={{ width: `${(clip.endSeconds - clip.startSeconds) / timeline.durationSeconds * 100}%` }} onClick={() => setSelectedClipId(clip.id)}>
                <strong>{clip.label}</strong><small>{formatTime(clip.startSeconds)}–{formatTime(clip.endSeconds)}</small><span>{clip.renderId ? "Still ready" : "Missing render"}</span>
              </button>
            ))}
          </div>
          {selectedClipId && <div className="clip-controls"><strong>Adjust selected clip</strong><button onClick={() => void nudgeBoundary("start", -.1)}>Start −0.1s</button><button onClick={() => void nudgeBoundary("start", .1)}>Start +0.1s</button><button onClick={() => void nudgeBoundary("end", -.1)}>End −0.1s</button><button onClick={() => void nudgeBoundary("end", .1)}>End +0.1s</button></div>}
          <div className="future-tools">{["Captions","Animation","Transitions","Audio mixing"].map((tool) => <button key={tool} disabled><strong>{tool}</strong><span>Planned after 1.0</span></button>)}</div>
        </div>
      )}
    </section>
  );
}

export function App() {
  const {
    stage,
    theme,
    activeChannelId,
    activeVideoId,
  } = useAppStore();
  const [startupNotice, setStartupNotice] = useState<string | null>(null);
  useEffect(() => document.documentElement.setAttribute("data-theme", theme), [theme]);
  useEffect(() => log("info", "application_started", { release: "1.2.0" }), []);
  useEffect(() => { void projectsClient.startupDiagnostic().then(setStartupNotice); }, []);
  useEffect(() => log("debug", "stage_opened", { stage }), [stage]);
  useEffect(() => {
    if (!activeChannelId || !activeVideoId) return;
    void projectsClient.setResume(activeChannelId, activeVideoId, stage);
  }, [activeChannelId, activeVideoId, stage]);
  useEffect(() => {
    if (!activeVideoId) return;
    const checkpoint = window.setInterval(() => {
      void projectsClient.createSnapshot(activeVideoId, {
        reason: "five-minute-checkpoint",
        stage: useAppStore.getState().stage,
      });
    }, 5 * 60 * 1000);
    return () => window.clearInterval(checkpoint);
  }, [activeVideoId]);
  return (
    <div className="app-shell">
      <Sidebar />
      <main><Header />{startupNotice && <div className="startup-notice">{startupNotice}<button onClick={() => setStartupNotice(null)}>Dismiss</button></div>}{stage === "home" && <HomeView />}{["inputs", "visual-plan"].includes(stage) && <ProductionView />}{stage === "images" && <ImagesView />}{stage === "timeline" && <TimelineView />}</main>
    </div>
  );
}

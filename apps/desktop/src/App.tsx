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
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type AppStage, useAppStore } from "./store/app-store";
import { log } from "./infrastructure/logger";
import {
  projectsClient,
  type ChannelRecord,
  type ResumeRecord,
  type VideoRecord,
  type VisualPlanRecord,
} from "./infrastructure/projects-client";

const navItems: { stage: AppStage; label: string; icon: typeof Home }[] = [
  { stage: "home", label: "Home", icon: Home },
  { stage: "inputs", label: "Inputs", icon: Upload },
  { stage: "visual-plan", label: "Visual plan", icon: FolderOpen },
  { stage: "images", label: "Images", icon: Image },
];

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${String(minutes).padStart(2, "0")}:${remainder}`;
}

function Sidebar() {
  const { stage, setStage } = useAppStore();
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => setStage("home")}>
        <span className="brand-mark"><span /></span>
        <span>Auto Gen <strong>Studio</strong></span>
      </button>
      <nav>
        {navItems.map(({ stage: itemStage, label, icon: Icon }) => (
          <button
            className={stage === itemStage ? "nav-item active" : "nav-item"}
            key={itemStage}
            onClick={() => setStage(itemStage)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <button className="nav-item settings"><Settings size={18} /><span>Settings</span></button>
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
      <div className="section-heading"><h2>Channels</h2><div><button onClick={() => void openTrash()}><Trash2 size={14} /> Trash</button><button onClick={() => setDialog("channel")}>+ Add channel</button></div></div>
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
  const [audio, setAudio] = useState<import("./infrastructure/projects-client").InputAssetRecord | null>(null);
  const [references, setReferences] = useState<import("./infrastructure/projects-client").InputAssetRecord[]>([]);
  const [status, setStatus] = useState("Loading source material…");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!activeVideoId) return;
    void projectsClient.getVideoInputs(activeVideoId).then((inputs) => {
      setScript(inputs.scriptText);
      setPacing(inputs.pacingSeconds);
      setAudio(inputs.audio);
      setReferences(inputs.references);
      setStatus("Saved locally");
      setHydrated(true);
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

  async function importAsset(kind: "audio" | "reference") {
    if (!activeVideoId) return;
    const asset = await projectsClient.pickAndImportAsset(activeVideoId, kind);
    if (!asset) return;
    if (kind === "audio") setAudio(asset);
    else setReferences((items) => [...items, asset]);
  }

  async function removeAsset(assetId: string) {
    await projectsClient.removeInputAsset(assetId);
    if (audio?.id === assetId) setAudio(null);
    setReferences((items) => items.filter((item) => item.id !== assetId));
  }

  const wordCount = script.trim() ? script.trim().split(/\s+/).length : 0;
  const ready = Boolean(script.trim() && audio);
  return (
    <section className="view">
      <div className="page-heading"><div><p className="eyebrow">Stage 1 of 3</p><h1>Source material</h1><p>Add narration and references that will guide the visual plan.</p></div><span className="save-state">{status}</span></div>
      {!activeVideoId && <div className="inline-error">Open or create a video before adding source material.</div>}
      {error && <div className="inline-error">{error}</div>}
      <div className="inputs-grid">
        <article className="panel script-panel">
          <div className="panel-heading"><div><h2>Script</h2><p>Paste narration or import a UTF-8 text file.</p></div><button className="secondary" onClick={() => void projectsClient.pickScriptText().then((text) => { if (text !== null) setScript(text); })}><Upload size={15} />Import</button></div>
          <textarea value={script} onChange={(event) => { setScript(event.target.value); setStatus("Saving…"); }} placeholder="Paste the final narration script here…" />
          <footer><span>{wordCount.toLocaleString()} words</span><span>Approx. {Math.ceil(wordCount / 150)} min</span></footer>
        </article>
        <div className="panel-stack">
          <article className="panel"><div className="panel-heading"><div><h2>Narration audio</h2><p>Used for word-level timing.</p></div><button className="secondary" onClick={() => void importAsset("audio")}><Upload size={15} />{audio ? "Replace" : "Import"}</button></div>{audio ? <div className="file-row"><span>♪</span><div><strong>{audio.originalName}</strong><small>{(audio.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></div><button className="icon-button" onClick={() => void removeAsset(audio.id)}><X size={15} /></button></div> : <div className="asset-empty">WAV, MP3, M4A, AAC, or FLAC</div>}</article>
          <article className="panel"><div className="panel-heading"><div><h2>Visual references</h2><p>Optional style and subject guidance.</p></div><button className="secondary" onClick={() => void importAsset("reference")}><Plus size={15} />Add</button></div><div className="reference-list">{references.map((reference) => <div key={reference.id}><span>IMG</span><p>{reference.originalName}</p><button onClick={() => void removeAsset(reference.id)}><X size={13} /></button></div>)}{references.length === 0 && <div className="asset-empty">PNG, JPEG, or WebP</div>}</div></article>
          <article className="panel"><div className="pacing-heading"><div><h2>Scene pacing</h2><p>Target duration per still</p></div><strong>{pacing} sec</strong></div><input type="range" min="4" max="14" value={pacing} onChange={(event) => { setPacing(Number(event.target.value)); setStatus("Saving…"); }} /></article>
          <article className={ready ? "readiness ready" : "readiness"}><strong>{ready ? "Ready for visual planning" : "Source material incomplete"}</strong><span>{ready ? "Script and narration audio are available." : "Add a script and narration audio to continue."}</span></article>
        </div>
      </div>
      <div className="footer-actions"><button className="secondary" onClick={() => setStage("home")}>Back</button><button className="primary" disabled={!ready || !activeVideoId} onClick={() => void projectsClient.generateVisualPlan(activeVideoId!).then(() => setStage("visual-plan")).catch((caught) => setError(String(caught)))}>Generate visual plan →</button></div>
    </section>
  );
}

function VisualPlanView() {
  const { activeVideoId, setStage } = useAppStore();
  const [plan, setPlan] = useState<VisualPlanRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <section className="view">
      <div className="page-heading">
        <div><p className="eyebrow">Stage 2 of 3</p><h1>Visual plan</h1><p>Drag a sentence into an adjacent still to regroup it. Chronological order remains enforced.</p></div>
        <div className="heading-actions"><button className="secondary" disabled={!plan} onClick={() => void resetPlan()}>Reset original</button><button className="primary" disabled={!plan} onClick={() => setStage("images")}>Continue to images →</button></div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {!plan && !error && <div className="empty-state">Loading visual plan…</div>}
      {plan && <><div className="plan-summary"><strong>{plan.groups.length} stills</strong><span>{plan.timingSource} timing · Original plan is always recoverable</span></div>
      <div className="plan-list">
        {plan.groups.map((group, index) => {
          const members = group.sentenceIds.map((id) => plan.sentences.find((sentence) => sentence.id === id)).filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence)).sort((a,b) => a.ordinal-b.ordinal);
          const timing = { startSeconds: members[0].startSeconds, endSeconds: members.at(-1)!.endSeconds, durationSeconds: members.at(-1)!.endSeconds-members[0].startSeconds, members };
          return (
            <article
              className="plan-row"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void moveSentence(event.dataTransfer.getData("text/sentence-id"), group.id)}
            >
              <span className="plan-index">{String(index + 1).padStart(2, "0")}</span>
              <div className="timing"><strong>{formatTime(timing.startSeconds)} – {formatTime(timing.endSeconds)}</strong><small>{timing.durationSeconds.toFixed(1)} sec</small></div>
              <div className="sentences">
                {timing.members.map((sentence) => (
                  <div
                    className="sentence"
                    draggable
                    key={sentence.id}
                    onDragStart={(event) => event.dataTransfer.setData("text/sentence-id", sentence.id)}
                  >
                    <b>⠿</b><span>{sentence.text}</span><small>{formatTime(sentence.startSeconds)}</small>
                  </div>
                ))}
              </div>
              <div className="scene-label"><span>{group.kind}</span><small>{group.label}</small></div>
            </article>
          );
        })}
      </div></>}
    </section>
  );
}

function ImagesView() {
  return (
    <section className="view image-view">
      <div className="page-heading"><div><p className="eyebrow">Stage 3 of 3</p><h1>Image generation</h1></div><button className="primary"><WandSparkles size={17} />Generate pending</button></div>
      <div className="image-workspace">
        <aside className="stills"><strong>Stills <span>12/18</span></strong>{[1,2,3,4,5,6].map((item) => <button className={item === 4 ? "active" : ""} key={item}><span>{item < 6 ? `v${(item % 3) + 1}` : "Pending"}</span><small>Still {String(item).padStart(2, "0")}</small></button>)}</aside>
        <div className="preview"><header><span>Still 04</span><strong>00:26.4 – 00:35.8</strong></header><div className="preview-art"><Sparkles size={42} /><p>Generated image preview</p></div><footer>Far below the sunlit surface lies a world suspended between light and darkness.</footer></div>
        <aside className="prompt-panel"><div className="tabs"><button className="active">Prompt</button><button>Settings</button></div><label>Scene prompt<textarea defaultValue="A wide cinematic view descending into the ocean's twilight zone, faint shafts of blue sunlight dissolving into darkness, suspended particles, immense scale, scientifically accurate deep-sea environment." /></label><button className="secondary"><Sparkles size={15} />Suggest improvement</button><button className="primary full">Generate new version</button><div className="placeholder"><strong>Animation</strong><span>Planned for a later release</span></div></aside>
      </div>
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
  useEffect(() => document.documentElement.setAttribute("data-theme", theme), [theme]);
  useEffect(() => log("info", "application_started", { release: "0.4.0" }), []);
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
      <main><Header />{stage === "home" && <HomeView />}{stage === "inputs" && <InputsView />}{stage === "visual-plan" && <VisualPlanView />}{stage === "images" && <ImagesView />}</main>
    </div>
  );
}

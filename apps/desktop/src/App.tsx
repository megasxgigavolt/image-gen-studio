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
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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
  { stage: "inputs", label: "Inputs", icon: Upload },
  { stage: "visual-plan", label: "Visual plan", icon: FolderOpen },
  { stage: "images", label: "Images", icon: Image },
  { stage: "timeline", label: "Timeline", icon: PanelsTopLeft },
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
  const { activeVideoId } = useAppStore();
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [activePromptVersionId, setActivePromptVersionId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [settingsJson, setSettingsJson] = useState("{}");
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-flash-image");
  const [openAiModel, setOpenAiModel] = useState("gpt-4.1");
  const [geminiKey, setGeminiKey] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState({ gemini: false, openai: false });
  const [tab, setTab] = useState<"prompt" | "settings">("prompt");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImageJobRecord | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [compareRenderId, setCompareRenderId] = useState<string | null>(null);
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [editInstruction, setEditInstruction] = useState("");

  const selectedGroup = useMemo(
    () => workspace?.groups.find((group) => group.group.id === selectedGroupId) ?? null,
    [workspace, selectedGroupId],
  );

  useEffect(() => {
    async function loadWorkspace() {
      if (!activeVideoId) return;
      setLoading(true);
      setError(null);
      try {
        const loaded = await projectsClient.getImageWorkspace(activeVideoId);
        setWorkspace(loaded);
        setSelectedGroupId(loaded.groups[0]?.group.id ?? null);
        setSettingsJson(loaded.settings.find((setting) => setting.key === "image_settings")?.value ?? "{}");
        setGeminiModel(loaded.settings.find((setting) => setting.key === "gemini_model")?.value ?? "gemini-2.5-flash-image");
        setOpenAiModel(loaded.settings.find((setting) => setting.key === "openai_model")?.value ?? "gpt-4.1");
        const [geminiStatus, openAiStatus] = await Promise.all([
          projectsClient.getProviderKeyStatus("gemini"),
          projectsClient.getProviderKeyStatus("openai"),
        ]);
        setKeyStatus({ gemini: geminiStatus.configured, openai: openAiStatus.configured });
        setJob(await projectsClient.getLatestImageJob(activeVideoId));
        const latest = loaded.groups[0]?.promptVersions[0];
        setActivePromptVersionId(latest?.id ?? null);
        setSystemPrompt(latest?.systemPrompt ?? "");
        setUserPrompt(latest?.userPrompt ?? "");
        const latestRender = loaded.groups[0]?.imageRenders[0];
        setSelectedRenderId(latestRender?.id ?? null);
        setCompareRenderId(latestRender?.parentRenderId ?? loaded.groups[0]?.imageRenders[1]?.id ?? null);
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
      setJob(latest);
      if (latest && ["completed", "failed"].includes(latest.status)) {
        setWorkspace(await projectsClient.getImageWorkspace(activeVideoId));
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeVideoId, job]);

  async function refreshWorkspace() {
    if (!activeVideoId) return;
    try {
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      setWorkspace(loaded);
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
    setLoading(true);
    setError(null);
    try {
      const version = await projectsClient.createPromptVersion(
        activeVideoId,
        selectedGroupId,
        settingsJson,
        systemPrompt,
        userPrompt,
      );
      setActivePromptVersionId(version.id);
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
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
          systemPrompt,
          userPrompt,
        )
      ).id;
      await projectsClient.generateImageRender(
        activeVideoId,
        selectedGroupId,
        versionId,
        systemPrompt,
        userPrompt,
        settingsJson,
      );
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function generatePending() {
    if (!activeVideoId) return;
    setLoading(true);
    setError(null);
    try {
      setJob(await projectsClient.createImageJob(activeVideoId));
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
    setSettingsJson(version.settingsJson);
  }

  function selectGroup(groupId: string) {
    setSelectedGroupId(groupId);
    const latest = workspace?.groups.find((item) => item.group.id === groupId)?.promptVersions[0];
    setActivePromptVersionId(latest?.id ?? null);
    setSystemPrompt(latest?.systemPrompt ?? "");
    setUserPrompt(latest?.userPrompt ?? "");
    setSettingsJson(latest?.settingsJson ?? "{}");
    const latestRender = workspace?.groups.find((item) => item.group.id === groupId)?.imageRenders[0];
    setSelectedRenderId(latestRender?.id ?? null);
    setCompareRenderId(latestRender?.parentRenderId ?? null);
  }

  async function saveSettings() {
    setLoading(true);
    setError(null);
    try {
      JSON.parse(settingsJson);
      await projectsClient.saveAppSetting("image_settings", settingsJson);
      await projectsClient.saveAppSetting("gemini_model", geminiModel.trim());
      await projectsClient.saveAppSetting("openai_model", openAiModel.trim());
      if (geminiKey.trim()) await projectsClient.saveProviderKey("gemini", geminiKey.trim());
      if (openAiKey.trim()) await projectsClient.saveProviderKey("openai", openAiKey.trim());
      setKeyStatus({ gemini: keyStatus.gemini || Boolean(geminiKey.trim()), openai: keyStatus.openai || Boolean(openAiKey.trim()) });
      setGeminiKey("");
      setOpenAiKey("");
      await refreshWorkspace();
    } catch (caught) {
      setError(caught instanceof SyntaxError ? "Image settings must be valid JSON." : String(caught));
    } finally {
      setLoading(false);
    }
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

  async function editSelectedRender() {
    if (!selectedRenderId || !editInstruction.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const edited = await projectsClient.editImageRender(selectedRenderId, editInstruction.trim());
      setCompareRenderId(selectedRenderId);
      setSelectedRenderId(edited.id);
      setEditInstruction("");
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
    <section className="view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Stage 3 of 3</p>
          <h1>Image generation</h1>
          <p>Select a still, review prompt versions, and generate render outputs.</p>
        </div>
        <div className="heading-actions"><button className="secondary" onClick={() => void exportStills()}><Download size={16} />Export stills</button><button className="secondary" onClick={() => void exportBundle()}><Download size={16} />Project bundle</button><button className="primary" onClick={() => void generatePending()} disabled={!workspace?.groups.length || loading || Boolean(job && ["queued", "running", "paused"].includes(job.status))}><WandSparkles size={17} /> Generate pending</button></div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      {job && (
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
      <div className="image-workspace">
        <aside className="stills">
          <strong>Stills <span>{stillCount}</span></strong>
          {workspace?.groups.map((group) => (
            <button
              key={group.group.id}
              className={group.group.id === selectedGroupId ? "active" : ""}
              onClick={() => selectGroup(group.group.id)}
            >
              <span>{group.promptVersions[0] ? `v${group.promptVersions[0].version}` : "New"}</span>
              <small>{group.group.label}</small>
            </button>
          ))}
          {!workspace && <div className="empty-state">Loading stills…</div>}
        </aside>
        <div className="preview">
          <header>
            <span>{previewLabel}</span>
            <strong>{selectedGroup?.group.sentenceIds.length ? `${selectedGroup.group.sentenceIds.length} sentence(s)` : "No scene selected"}</strong>
          </header>
          <div className={compareRenderId ? "preview-art comparison" : "preview-art"}>
            {selectedRenderId && renderUrls[selectedRenderId] ? (
              <figure><img src={renderUrls[selectedRenderId]} alt="Selected image version" /><figcaption>Selected</figcaption></figure>
            ) : <><Sparkles size={42} /><p>{selectedGroup ? "No rendered version yet" : "Choose a still to begin."}</p></>}
            {compareRenderId && renderUrls[compareRenderId] && (
              <figure><img src={renderUrls[compareRenderId]} alt="Comparison image version" /><figcaption>Compare</figcaption></figure>
            )}
          </div>
          <footer>
            {selectedGroup?.group.sentenceIds.length
              ? `Group ${selectedGroup?.group.id} contains ${selectedGroup.group.sentenceIds.length} sentence(s).`
              : "No prompt yet."}
          </footer>
        </div>
        <aside className="prompt-panel">
          <div className="tabs">
            <button className={tab === "prompt" ? "active" : ""} onClick={() => setTab("prompt")}>Prompt</button>
            <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
          </div>
          {tab === "prompt" ? (
            <>
              <label>
                System prompt
                <textarea
                  value={systemPrompt}
                  onChange={(event) => setSystemPrompt(event.target.value)}
                  placeholder="System prompt for image generation"
                />
              </label>
              <label>
                User prompt
                <textarea
                  value={userPrompt}
                  onChange={(event) => setUserPrompt(event.target.value)}
                  placeholder="User prompt for image generation"
                />
              </label>
              <button className="secondary" disabled>
                <Sparkles size={15} /> Suggest improvement
              </button>
              <button className="primary full" onClick={() => void createVersion()} disabled={!selectedGroupId || loading}>
                Save prompt version
              </button>
              <button className="secondary full" onClick={() => void generateRender()} disabled={!selectedGroupId || loading}>Generate this still</button>
              <div className="placeholder">
                <strong>Prompt history</strong>
                <span>{promptVersions.length ? `${promptVersions.length} saved versions` : "No saved prompt versions yet."}</span>
              </div>
              {promptVersions.length > 0 && (
                <div className="prompt-history">
                  {promptVersions.map((version) => (
                    <button
                      key={version.id}
                      className={version.id === activePromptVersionId ? "active" : ""}
                      onClick={() => selectVersion(version)}
                    >
                      <span>v{version.version}</span>
                      <small>{new Date(version.createdAt).toLocaleString()}</small>
                    </button>
                  ))}
                </div>
              )}
              {imageRenders.length > 0 && (
                <div className="placeholder">
                  <strong>Render history</strong>
                  <span>{imageRenders.length} render(s) stored</span>
                </div>
              )}
              {imageRenders.map((render) => (
                <div key={render.id} className="prompt-history">
                  <button type="button" className={render.id === selectedRenderId ? "active" : ""} onClick={() => selectRender(render)}>
                    <span>v{render.version} · {render.kind}</span>
                    <small>{render.editInstruction ?? new Date(render.createdAt).toLocaleString()}</small>
                  </button>
                </div>
              ))}
              {selectedRenderId && (
                <div className="edit-panel">
                  <label>Edit instruction<textarea value={editInstruction} onChange={(event) => setEditInstruction(event.target.value)} placeholder="Remove the buoy while preserving everything else." /></label>
                  <button className="primary full" onClick={() => void editSelectedRender()} disabled={!editInstruction.trim() || loading}>Edit selected version</button>
                  <small>The selected image is sent back to Gemini as visual context.</small>
                </div>
              )}
            </>
          ) : (
            <>
              <label>
                Image settings JSON
                <textarea
                  value={settingsJson}
                  onChange={(event) => setSettingsJson(event.target.value)}
                  rows={8}
                  placeholder="Image generation settings JSON"
                />
              </label>
              <label>Gemini image model<input value={geminiModel} onChange={(event) => setGeminiModel(event.target.value)} /></label>
              <label>Gemini API key <small>{keyStatus.gemini ? "Configured" : "Not configured"}</small><input type="password" value={geminiKey} onChange={(event) => setGeminiKey(event.target.value)} placeholder={keyStatus.gemini ? "Enter to replace" : "Required"} /></label>
              <label>OpenAI model<input value={openAiModel} onChange={(event) => setOpenAiModel(event.target.value)} /></label>
              <label>OpenAI API key <small>{keyStatus.openai ? "Configured" : "Not configured"}</small><input type="password" value={openAiKey} onChange={(event) => setOpenAiKey(event.target.value)} placeholder={keyStatus.openai ? "Enter to replace" : "Optional"} /></label>
              <button className="primary full" onClick={() => void saveSettings()} disabled={loading}>Apply settings</button>
              <div className="placeholder">
                <strong>Stored settings</strong>
                <span>{workspace?.settings.length ? `${workspace.settings.length} setting(s)` : "No settings saved."}</span>
              </div>
              {workspace?.settings.map((setting) => (
                <div key={setting.key} className="prompt-history">
                  <button type="button">
                    <span>{setting.key}</span>
                    <small>{setting.value}</small>
                  </button>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
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
  useEffect(() => document.documentElement.setAttribute("data-theme", theme), [theme]);
  useEffect(() => log("info", "application_started", { release: "0.9.0" }), []);
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
      <main><Header />{stage === "home" && <HomeView />}{stage === "inputs" && <InputsView />}{stage === "visual-plan" && <VisualPlanView />}{stage === "images" && <ImagesView />}{stage === "timeline" && <TimelineView />}</main>
    </div>
  );
}

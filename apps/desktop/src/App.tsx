import {
  Film,
  FolderOpen,
  Home,
  Image,
  Minus,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Undo2,
  Upload,
  X,
  WandSparkles,
  Download,
  LoaderCircle,
  GripVertical,
  Check,
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  MoreHorizontal,
  ImageOff,
  Search,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type AppStage, lastSelectedStill, useAppStore } from "./store/app-store";
import { log } from "./infrastructure/logger";
import { resolveAssetUrl, resolveRenderUrl } from "./infrastructure/media-cache";
import { formatTimeShort } from "./domain/timecode";
import {
  projectsClient,
  type ChannelRecord,
  type ResumeRecord,
  type VideoRecord,
  type VisualPlanRecord,
  type ImageWorkspaceRecord,
  type ImageJobRecord,
  type ImageRenderRecord,
} from "./infrastructure/projects-client";
import { TimelineView } from "./TimelineView";

const navItems: { stage: AppStage; label: string; icon: typeof Home; alwaysEnabled?: boolean }[] = [
  { stage: "inputs", label: "Production", icon: Upload },
  { stage: "images", label: "Images", icon: Image },
  { stage: "timeline", label: "Editor", icon: Film },
];
const MAX_CACHE_SIZE = 20;
const imageWorkspaceCache = new Map<string, ImageWorkspaceRecord>();

function setCached(key: string, value: ImageWorkspaceRecord) {
  if (imageWorkspaceCache.size >= MAX_CACHE_SIZE) {
    const oldest = imageWorkspaceCache.keys().next().value;
    if (oldest !== undefined) imageWorkspaceCache.delete(oldest);
  }
  imageWorkspaceCache.set(key, value);
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const focusable = el.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else { if (document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    el.addEventListener("keydown", trap);
    return () => el.removeEventListener("keydown", trap);
  }, []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div ref={dialogRef} className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>{message}</p>
        <div className="footer-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ToastDisplay() {
  const { toast, dismissToast } = useAppStore();
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, 4500);
    return () => window.clearTimeout(timer);
  }, [toast?.id, dismissToast]);
  if (!toast) return null;
  return (
    <div className={`app-toast app-toast-${toast.kind}`} role="alert">
      <span>{toast.message}</span>
      <button type="button" onClick={dismissToast} aria-label="Dismiss">×</button>
    </div>
  );
}

function TitleBar() {
  const win = getCurrentWindow();
  const titlebarActions = useAppStore((state) => state.titlebarActions);
  const activeChannelName = useAppStore((state) => state.activeChannelName);
  const activeVideoTitle = useAppStore((state) => state.activeVideoTitle);
  const breadcrumb = ["Studio", activeChannelName, activeVideoTitle].filter(Boolean).join(" › ");
  return (
    <div className="titlebar">
      <span className="titlebar-title" data-tauri-drag-region>{breadcrumb}</span>
      {titlebarActions && <div className="titlebar-actions" onPointerDown={(e) => e.stopPropagation()}>{titlebarActions}</div>}
      <div className="titlebar-controls">
        <button className="titlebar-btn minimize" onPointerDown={(e) => e.stopPropagation()} onClick={() => void win.minimize()} aria-label="Minimize"><Minus size={13} strokeWidth={2} /></button>
        <button className="titlebar-btn maximize" onPointerDown={(e) => e.stopPropagation()} onClick={() => void win.toggleMaximize()} aria-label="Maximize"><Square size={11} strokeWidth={1.8} /></button>
        <button className="titlebar-btn close" onPointerDown={(e) => e.stopPropagation()} onClick={() => void win.close()} aria-label="Close"><X size={13} strokeWidth={2} /></button>
      </div>
    </div>
  );
}

function Sidebar() {
  const { stage, setStage, activeVideoId, lastProductionStage, clearActiveProject } = useAppStore();
  const [appVersion, setAppVersion] = useState("");
  const [confirmHome, setConfirmHome] = useState(false);

  useEffect(() => {
    void projectsClient.getApplicationVersion().then(setAppVersion);
  }, []);

  function handleBrandClick() {
    if (activeVideoId) {
      setConfirmHome(true);
    } else {
      setStage("home");
    }
  }

  return (
    <aside className="sidebar">
      <button className="brand" onClick={handleBrandClick}>
        <span className="brand-mark"><span /></span>
        <span>Auto Gen <strong>Studio</strong></span>
      </button>
      <nav>
        {navItems.map(({ stage: itemStage, label, icon: Icon, alwaysEnabled }) => {
          const isActive = itemStage === "inputs"
            ? ["inputs", "visual-plan"].includes(stage)
            : stage === itemStage;
          const isDisabled = !alwaysEnabled && !activeVideoId;
          return (
            <button
              className={isActive ? "nav-item active" : "nav-item"}
              key={itemStage}
              onClick={() => setStage(itemStage === "inputs" ? lastProductionStage : itemStage)}
              disabled={isDisabled}
              title={isDisabled ? "Open a video first" : undefined}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <button className="nav-item settings" disabled title="Coming soon">
        <Settings size={18} /><span>Preferences</span>
      </button>
      {appVersion && <small className="app-version-line">v{appVersion}</small>}
      {confirmHome && createPortal(
        <ConfirmDialog
          title="Leave this project?"
          message="Your work is saved automatically. Returning home will close this project — you can resume it anytime from the home screen."
          confirmLabel="Save & Return Home"
          onConfirm={() => {
            setConfirmHome(false);
            clearActiveProject();
            setStage("home");
          }}
          onCancel={() => setConfirmHome(false)}
        />,
        document.body,
      )}
    </aside>
  );
}

function Header() {
  const { stage, theme, toggleTheme, activeVideoTitle } = useAppStore();

  function handleToggleTheme() {
    toggleTheme();
    const nextTheme = theme === "light" ? "dark" : "light";
    void projectsClient.saveAppSetting("theme", nextTheme);
  }

  return (
    <header className="topbar">
      <div>
        {stage === "home" && (
          <button className="brand active" aria-current="page">
            <span className="brand-mark"><span /></span>
            <span>Auto Gen <strong>Studio</strong></span>
          </button>
        )}
        {activeVideoTitle && <strong>{activeVideoTitle}</strong>}
      </div>
      <div className="top-actions">
        <span className="saved">Saved locally</span>
        <button className="icon-button" onClick={handleToggleTheme} aria-label="Toggle theme">
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
      </div>
    </header>
  );
}

function RowMenu({ anchorRect, onRename, onDelete, onClose }: {
  anchorRect: DOMRect;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);
  return createPortal(
    <div
      className="row-menu"
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: anchorRect.bottom + 4, left: anchorRect.right, transform: "translateX(-100%)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button role="menuitem" onClick={() => { onRename(); onClose(); }}>Rename</button>
      <button role="menuitem" className="danger-action" onClick={() => { onDelete(); onClose(); }}>Delete</button>
    </div>,
    document.body,
  );
}

function stageLabel(stage: AppStage): string {
  if (stage === "timeline") return "Editor";
  if (stage === "visual-plan") return "Plan";
  if (stage === "images") return "Visuals";
  if (stage === "inputs") return "Inputs";
  return stage;
}

const PIPELINE_STAGES: { stage: AppStage; label: string }[] = [
  { stage: "inputs", label: "Inputs" },
  { stage: "visual-plan", label: "Plan" },
  { stage: "images", label: "Visuals" },
  { stage: "timeline", label: "Editor" },
];

function StageProgress({ stage }: { stage: AppStage }) {
  const current = PIPELINE_STAGES.findIndex((entry) => entry.stage === stage);
  return (
    <div className="stage-bar">
      {PIPELINE_STAGES.map((entry, index) => (
        <i key={entry.stage} className={index < current ? "done" : index === current ? "active" : undefined} />
      ))}
    </div>
  );
}

let hasShownResumeBannerThisSession = false;

function HomeView() {
  const { setStage, setActiveProject, activeChannelId } = useAppStore();
  const [showResumeBanner] = useState(() => {
    const isFirstVisit = !hasShownResumeBannerThisSession;
    hasShownResumeBannerThisSession = true;
    return isFirstVisit;
  });
  const [channels, setChannels] = useState<ChannelRecord[]>([]);
  const [videos, setVideos] = useState<VideoRecord[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(activeChannelId);
  const [resume, setResume] = useState<ResumeRecord | null>(null);
  const [dialog, setDialog] = useState<"channel" | "video" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);
  const [renamingVideoId, setRenamingVideoId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [videoPreviewUrls, setVideoPreviewUrls] = useState<Record<string, string>>({});
  const [channelMenu, setChannelMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [videoMenu, setVideoMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const clickTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    void projectsClient.getApplicationVersion().then(setAppVersion);
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    void Promise.all(videos.map(async (video) => {
      try {
        const progress = await projectsClient.getVideoProgress(video.id);
        if (cancelled || !progress.previewRenderId) return;
        const url = await resolveRenderUrl(progress.previewRenderId);
        if (!cancelled) setVideoPreviewUrls((current) => ({ ...current, [video.id]: url }));
      } catch {
        // A video without a visual plan yet has no progress to show.
      }
    }));
    return () => { cancelled = true; };
  }, [videos]);

  const handleSingleOrDoubleClick = useCallback((id: string, onSingle: () => void, onDouble: () => void) => {
    const pending = clickTimers.current[id];
    if (pending) {
      window.clearTimeout(pending);
      delete clickTimers.current[id];
      onDouble();
    } else {
      clickTimers.current[id] = window.setTimeout(() => {
        delete clickTimers.current[id];
        onSingle();
      }, 250);
    }
  }, []);

  async function selectChannel(channelId: string) {
    setSelectedChannelId(channelId);
    try {
      setVideos(await projectsClient.listVideos(channelId));
    } catch (caught) {
      setError(String(caught));
    }
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
    // Navigate first; persisting resume/snapshot is best-effort and must never
    // block or cancel navigation if a database write happens to fail.
    setActiveProject(channel.id, channel.name, video.id, video.title);
    setStage(video.stage);
    try {
      await projectsClient.setResume(channel.id, video.id, video.stage);
      await projectsClient.createSnapshot(video.id, {
        reason: "video-opened",
        stage: video.stage,
      });
    } catch (caught) {
      log("error", "open_video_side_effects_failed", { message: String(caught) });
    }
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

  async function startRenameChannel(channel: ChannelRecord) {
    setRenamingChannelId(channel.id);
    setRenameValue(channel.name);
  }

  async function commitRenameChannel(channelId: string) {
    const trimmed = renameValue.trim();
    setRenamingChannelId(null);
    if (!trimmed) return;
    try {
      await projectsClient.renameChannel(channelId, trimmed);
      await loadWorkspace();
    } catch (caught) { setError(String(caught)); }
  }

  async function startRenameVideo(video: VideoRecord) {
    setRenamingVideoId(video.id);
    setRenameValue(video.title);
  }

  async function commitRenameVideo(videoId: string) {
    const trimmed = renameValue.trim();
    setRenamingVideoId(null);
    if (!trimmed) return;
    try {
      await projectsClient.renameVideo(videoId, trimmed);
      await loadWorkspace();
    } catch (caught) { setError(String(caught)); }
  }

  const resumeVideoRecord = videos.find((video) => video.id === resume?.videoId);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  return (
    <div className="view launcher">
      <aside className="launcher-panel">
        <h1>{getGreeting()}</h1>
        <p>Select a project or start something new.</p>
        {error && <div className="inline-error">{error}</div>}
        {loading && <div className="empty-state compact">Loading local workspace…</div>}
        {!loading && channels.length === 0 && (
          <div className="empty-state compact"><FolderOpen size={26} /><h2>Create your first channel</h2><p>Videos and assets will be stored locally in its project folder.</p></div>
        )}
        {!loading && (
          <div className="section-heading"><h2>Channels</h2><div><button onClick={() => setDialog("channel")}><Plus size={14} /> Add channel</button></div></div>
        )}
        {!loading && (
          <div className="channel-list">
            {channels.map((channel) => (
              <div className={selectedChannelId === channel.id ? "channel active" : "channel"} key={channel.id}>
                {renamingChannelId === channel.id ? (
                  <div style={{ padding: "10px", display: "flex", gap: "6px", alignItems: "center", flex: 1 }}>
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameValue}
                      maxLength={80}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void commitRenameChannel(channel.id); if (e.key === "Escape") setRenamingChannelId(null); }}
                      onBlur={() => void commitRenameChannel(channel.id)}
                    />
                  </div>
                ) : (
                  <button onClick={() => handleSingleOrDoubleClick(channel.id, () => void selectChannel(channel.id), () => void startRenameChannel(channel))}>
                    <span>{channel.name.split(/\s+/).slice(0, 2).map((word) => ([...word][0] ?? "")).join("").toUpperCase()}</span>
                    <div><strong>{channel.name}</strong><small>{channel.videoCount === 1 ? "1 video" : `${channel.videoCount} videos`}</small></div>
                  </button>
                )}
                <button
                  className={channelMenu?.id === channel.id ? "row-menu-trigger menu-open" : "row-menu-trigger"}
                  aria-label={`Options for ${channel.name}`}
                  onClick={(e) => setChannelMenu({ id: channel.id, rect: e.currentTarget.getBoundingClientRect() })}
                ><MoreHorizontal size={16} /></button>
                {channelMenu?.id === channel.id && (
                  <RowMenu
                    anchorRect={channelMenu.rect}
                    onRename={() => void startRenameChannel(channel)}
                    onDelete={() => void deleteChannel(channel.id)}
                    onClose={() => setChannelMenu(null)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        <button className="nav-item settings" disabled title="Coming soon">
          <Settings size={18} /><span>Preferences</span>
        </button>
        {appVersion && <small className="app-version-line">v{appVersion}</small>}
      </aside>
      <section className="launcher-videos">
        {resume && showResumeBanner && resume.channelId === selectedChannelId && (
          <button className="resume-band" onClick={() => void resumeVideo()}>
            <div><span>Continue</span><h2>{resumeVideoRecord?.title ?? "Resume last video"}</h2><p>{selectedChannel?.name} · {stageLabel(resume.stage)}</p></div>
            <strong>→</strong>
          </button>
        )}
        <div className="section-heading"><h2>Videos</h2><div><button disabled={!selectedChannelId} onClick={() => setDialog("video")}><Plus size={14} /> New video</button></div></div>
        {!loading && channels.length > 0 && (
          <div className="video-grid">
            {videos.map((video) => (
              <article className="video-card" key={video.id}>
                {renamingVideoId === video.id ? (
                  <div style={{ padding: "14px", display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameValue}
                      maxLength={80}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void commitRenameVideo(video.id); if (e.key === "Escape") setRenamingVideoId(null); }}
                      onBlur={() => void commitRenameVideo(video.id)}
                      style={{ flex: 1 }}
                    />
                  </div>
                ) : (() => {
                  const previewUrl = videoPreviewUrls[video.id];
                  return (
                    <button className="video-open" onClick={() => handleSingleOrDoubleClick(video.id, () => void openVideo(video), () => void startRenameVideo(video))}>
                      <div className={previewUrl ? "video-art has-preview" : "video-art video-art-empty"}>
                        {previewUrl ? <img src={previewUrl} alt="" /> : <ImageOff size={26} />}
                        {previewUrl && <span className="pill-badge">{stageLabel(video.stage)}</span>}
                      </div>
                      <div><h3>{video.title}</h3><p>{new Date(video.updatedAt).toLocaleDateString()}</p><StageProgress stage={video.stage} /></div>
                    </button>
                  );
                })()}
                <button
                  className={videoMenu?.id === video.id ? "row-menu-trigger card-menu-trigger menu-open" : "row-menu-trigger card-menu-trigger"}
                  aria-label={`Options for ${video.title}`}
                  onClick={(e) => setVideoMenu({ id: video.id, rect: e.currentTarget.getBoundingClientRect() })}
                ><MoreHorizontal size={16} /></button>
                {videoMenu?.id === video.id && (
                  <RowMenu
                    anchorRect={videoMenu.rect}
                    onRename={() => void startRenameVideo(video)}
                    onDelete={() => void deleteVideo(video.id)}
                    onClose={() => setVideoMenu(null)}
                  />
                )}
              </article>
            ))}
            <button className="video-card ghost" onClick={() => setDialog("video")}><Plus size={20} /><span>New video</span></button>
          </div>
        )}
        {!loading && channels.length === 0 && (
          <div className="empty-state"><FolderOpen size={28} /><h2>Create your first channel</h2><p>Add a channel on the left to start browsing videos.</p></div>
        )}
      </section>
      {(dialog === "channel" || dialog === "video") && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { setDialog(null); setName(""); }}>
          <form className="modal" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">{dialog === "channel" ? "New workspace" : "New production"}</p>
            <h2>{dialog === "channel" ? "Create channel" : "Create video"}</h2>
            <label>{dialog === "channel" ? "Channel name" : "Video title"}<input autoFocus value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setDialog(null); setName(""); } }} /></label>
            {!name.trim() && <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>Name cannot be empty.</p>}
            <div className="footer-actions"><button type="button" className="secondary" onClick={() => { setDialog(null); setName(""); }}>Cancel</button><button className="primary" type="submit" disabled={!name.trim()}>Create</button></div>
          </form>
        </div>
      )}
    </div>
  );
}

function InputsView() {
  const { setStage, activeVideoId } = useAppStore();
  const [script, setScript] = useState("");
  const [pacing, setPacing] = useState(8);
  const [pacingPreset, setPacingPreset] = useState<"calm" | "balanced" | "fast" | "custom" | "per-sentence">("balanced");
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
  }), [audio?.id, script]);

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

  async function choosePacing(preset: "calm" | "balanced" | "fast" | "custom" | "per-sentence", min = pacingMin, max = pacingMax) {
    if (!activeVideoId) return;
    const safeMin = preset === "custom" ? Math.min(min, max) : min;
    const safeMax = preset === "custom" ? Math.max(min, max) : max;
    // min/max are unused for grouping when preset is "per-sentence" (the
    // backend skips duration-window grouping entirely) — persisted anyway
    // since the column is NOT NULL with a validated 2-30s range.
    const ranges = { calm: [10, 16], balanced: [6, 10], fast: [3, 6], "per-sentence": [3, 6], custom: [safeMin, safeMax] } as const;
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
      <div className="page-heading"><div><h1>Source material</h1><p>Add narration and references that will guide the visual plan.</p></div><span className="save-state">{status}</span></div>
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
          <article className="panel"><div className="pacing-heading"><div><h2>Scene pacing</h2><p>Preferred duration range per still</p></div><strong>{pacingPreset === "per-sentence" ? "1 sentence" : `${pacingMin}–${pacingMax} sec`}</strong></div><div className="pacing-options">{([["calm","Calm","10–16s"],["balanced","Balanced","6–10s"],["fast","Fast","3–6s"],["per-sentence","Every sentence","1:1 split"],["custom","Custom","Choose range"]] as const).map(([value,label,detail]) => <button key={value} className={pacingPreset === value ? "active" : ""} onClick={() => void choosePacing(value)}><strong>{label}</strong><small>{detail}</small></button>)}</div>{pacingPreset === "per-sentence" ? <p style={{fontSize:"12px",color:"var(--text-muted)",margin:"8px 0 0"}}>Every sentence becomes its own still — no AI grouping, fastest to generate.</p> : <div className="custom-pacing"><label>Minimum<input type="number" min="2" max="30" value={pacingMin} disabled={pacingPreset !== "custom"} onChange={(event) => setPacingMin(Number(event.target.value))} onBlur={(event) => { if (pacingPreset === "custom") void choosePacing("custom", Number(event.target.value), pacingMax); }} /></label><label>Maximum<input type="number" min="2" max="30" value={pacingMax} disabled={pacingPreset !== "custom"} onChange={(event) => setPacingMax(Number(event.target.value))} onBlur={(event) => { if (pacingPreset === "custom") void choosePacing("custom", pacingMin, Number(event.target.value)); }} /></label></div>}</article>
          <article className={ready ? "readiness ready" : "readiness"}><strong>{ready ? "Ready for visual planning" : "Source material incomplete"}</strong><span>{ready ? "Script and narration audio are available." : "Add a script and narration audio to continue."}</span></article>
        </div>
      </div>
      <div className="footer-actions"><button className="secondary" onClick={() => setStage("home")}>Back</button>{hasPlan && inputSignature === generatedInputSignature ? <button className="primary" onClick={() => setStage("visual-plan")}>View visual plan →</button> : <button className="primary" disabled={!ready || !activeVideoId || generating} onClick={() => void generatePlan()}>{generating ? <><LoaderCircle className="spin" size={16} />Generating…</> : "Generate visual plan →"}</button>}</div>
    </section>
  );
}

function VisualPlanView() {
  const { activeVideoId, setStage } = useAppStore();
  const [plan, setPlan] = useState<VisualPlanRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedSentenceId, setDraggedSentenceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [editingSentenceId, setEditingSentenceId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  useEffect(() => {
    if (!activeVideoId) return;
    void projectsClient.getVisualPlan(activeVideoId).then(setPlan).catch((caught) => setError(String(caught)));
  }, [activeVideoId]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchRefs = useRef<Map<string, HTMLElement>>(new Map());

  function registerMatchRef(key: string, el: HTMLElement | null) {
    if (el) matchRefs.current.set(key, el);
    else matchRefs.current.delete(key);
  }

  // Every occurrence of the query within every sentence, in chronological
  // (ordinal) order — this is what Enter cycles through, not just the
  // sentences that contain a match.
  const searchMatches = useMemo(() => {
    const trimmed = searchQuery.trim().toLowerCase();
    if (!plan || !trimmed) return [] as { key: string; sentenceId: string }[];
    const sorted = [...plan.sentences].sort((a, b) => a.ordinal - b.ordinal);
    const results: { key: string; sentenceId: string }[] = [];
    for (const sentence of sorted) {
      const lowerText = sentence.text.toLowerCase();
      let occurrence = 0;
      let searchFrom = 0;
      while (true) {
        const idx = lowerText.indexOf(trimmed, searchFrom);
        if (idx === -1) break;
        results.push({ key: `${sentence.id}:${occurrence}`, sentenceId: sentence.id });
        searchFrom = idx + trimmed.length;
        occurrence++;
      }
    }
    return results;
  }, [plan, searchQuery]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.select());
  }, [searchOpen]);

  useEffect(() => {
    if (searchMatches.length === 0) return;
    const active = searchMatches[Math.min(matchIndex, searchMatches.length - 1)];
    matchRefs.current.get(active.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [matchIndex, searchMatches]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen]);

  function closeSearch() {
    setSearchOpen(false);
  }

  function navigateMatch(direction: 1 | -1) {
    if (searchMatches.length === 0) return;
    setMatchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length);
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  }

  const activeMatchKey = searchMatches.length > 0 ? searchMatches[Math.min(matchIndex, searchMatches.length - 1)].key : null;

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

  async function mergeSentences(firstSentenceId: string, secondSentenceId: string) {
    if (!activeVideoId) return;
    try { setPlan(await projectsClient.mergePlanSentences(activeVideoId, firstSentenceId, secondSentenceId)); }
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
    } else if (target.startsWith("sentence:")) {
      // Dropping one sentence onto another merges them — dropped-onto
      // wins as the "first" half only when it's actually the earlier one,
      // so chronology is preserved regardless of drag direction.
      const targetSentenceId = target.replace(/^sentence:/, "");
      if (targetSentenceId === sentenceId) return;
      const a = Number(sentenceId.slice(1));
      const b = Number(targetSentenceId.slice(1));
      const [firstId, secondId] = a < b ? [sentenceId, targetSentenceId] : [targetSentenceId, sentenceId];
      void mergeSentences(firstId, secondId);
    }
  }

  function startEditingSentence(sentence: PlanSentenceRecord) {
    setEditingSentenceId(sentence.id);
    setEditText(sentence.text);
  }

  function onEditTextChange(value: string) {
    setEditText(value);
  }

  // Fires only when the just-typed character was actually a period — NOT a
  // scan of the whole text for "does a period exist anywhere," which used
  // to misfire on backspace (or any edit) whenever the sentence already had
  // an unrelated period elsewhere, e.g. its own normal trailing full stop.
  // Takes the actual left/right text the caller already sliced from the
  // LIVE DOM content (not an offset re-applied against whatever's in the
  // database — those can differ by the just-typed period alone, or more if
  // earlier edits in the same session were never persisted, which silently
  // split at the wrong point).
  function onPeriodTyped(sentenceId: string, leftText: string, rightText: string) {
    if (!activeVideoId) return;
    setEditingSentenceId(null);
    setEditText("");
    projectsClient.splitPlanSentence(activeVideoId, sentenceId, leftText, rightText)
      .then(setPlan)
      .catch((caught) => setError(String(caught)));
  }

  async function commitSentenceEdit(sentenceId: string) {
    if (!activeVideoId) return;
    const text = editText;
    setEditingSentenceId(null);
    const original = plan?.sentences.find((s) => s.id === sentenceId)?.text;
    if (!text.trim() || text.trim() === original) return;
    try { setPlan(await projectsClient.updatePlanSentenceText(activeVideoId, sentenceId, text)); }
    catch (caught) { setError(String(caught)); }
  }

  return (
    <section className="view">
      <div className="page-heading">
        <div><h1>Visual plan</h1><p>Drag a sentence to regroup it, or onto another sentence's handle to merge. Double-click to edit. Chronological order remains enforced.</p></div>
        <div className="heading-actions"><button className="secondary" onClick={() => setStage("inputs")}>← Back</button><button className="secondary" disabled={!plan} onClick={() => setConfirmReset(true)}>Reset original</button><button className="primary" disabled={!plan} onClick={() => setStage("images")}>Continue to images →</button></div>
      </div>
      {searchOpen && (
        <div className="plan-search-bar">
          <Search size={14} />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Search sentences… (Enter for next, Shift+Enter for previous)"
            autoFocus
          />
          <span className="plan-search-count">{searchQuery.trim() ? `${searchMatches.length ? matchIndex + 1 : 0}/${searchMatches.length}` : ""}</span>
          <button type="button" onClick={() => navigateMatch(-1)} disabled={!searchMatches.length} aria-label="Previous match"><ChevronUp size={15} /></button>
          <button type="button" onClick={() => navigateMatch(1)} disabled={!searchMatches.length} aria-label="Next match"><ChevronDown size={15} /></button>
          <button type="button" onClick={closeSearch} aria-label="Close search"><X size={15} /></button>
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      {!plan && !error && <div className="empty-state">Loading visual plan…</div>}
      {confirmReset && <ConfirmDialog title="Reset visual plan?" message="This restores everything to exactly how it was right after generation — groupings, and any sentence edits, splits, or merges. Everything you've changed since then will be lost." confirmLabel="Reset" onConfirm={() => { setConfirmReset(false); void resetPlan(); }} onCancel={() => setConfirmReset(false)} />}
      {plan && <><div className="plan-summary"><strong>{plan.groups.length} stills</strong><span>{formatTimeShort(plan.sentences.at(-1)?.endSeconds ?? 0)} total · Average {((plan.sentences.at(-1)?.endSeconds ?? 0) / plan.groups.length).toFixed(1)} sec · {plan.timingSource}</span></div>
      <div className="plan-scroll"><DndContext
        sensors={sensors}
        // pointerWithin (not the default rectIntersection) so a small
        // nested target — the merge drop zone on a sentence's own grip
        // handle — reliably wins over the large still it sits inside, by
        // checking where the pointer actually is rather than which
        // rectangle it overlaps most. This is what makes "drop into this
        // still" (anywhere in the still) and "merge with this sentence"
        // (only its handle) unambiguous instead of racing each other.
        collisionDetection={pointerWithin}
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
              <div className="timing"><strong>{formatTimeShort(timing.startSeconds)} – {formatTimeShort(timing.endSeconds)}</strong><small>{timing.durationSeconds.toFixed(1)} sec</small></div>
              <div className="sentences">
                {timing.members.map((sentence) => (
                  <DraggableSentence
                    key={sentence.id}
                    sentence={sentence}
                    active={draggedSentenceId === sentence.id}
                    dropActive={dropTarget === `sentence:${sentence.id}`}
                    searchQuery={searchQuery}
                    activeMatchKey={activeMatchKey}
                    registerMatchRef={registerMatchRef}
                    editing={editingSentenceId === sentence.id}
                    editText={editText}
                    onStartEdit={() => startEditingSentence(sentence)}
                    onChangeText={onEditTextChange}
                    onPeriodTyped={(leftText, rightText) => onPeriodTyped(sentence.id, leftText, rightText)}
                    onCommit={() => void commitSentenceEdit(sentence.id)}
                    onCancel={() => setEditingSentenceId(null)}
                  />
                ))}
              </div>
            </DroppableStill>
            <StillDivider insertIndex={index + 1} active={dropTarget === `divider:${index + 1}`} />
          </div>;
        })}
      </div>
      </DndContext></div></>}
    </section>
  );
}

type PlanSentenceRecord = VisualPlanRecord["sentences"][number];

/** Splits `text` on every occurrence of `query`, wrapping matches in <mark>
 * so each instance can be independently scrolled to and marked active. */
function highlightSentenceText(
  text: string,
  query: string,
  sentenceId: string,
  activeMatchKey: string | null,
  registerMatchRef: (key: string, el: HTMLElement | null) => void,
): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let occurrence = 0;
  let searchFrom = 0;
  while (true) {
    const idx = lowerText.indexOf(lowerQuery, searchFrom);
    if (idx === -1) break;
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    const key = `${sentenceId}:${occurrence}`;
    parts.push(
      <mark
        key={key}
        ref={(el) => registerMatchRef(key, el)}
        className={key === activeMatchKey ? "search-match search-match-active" : "search-match"}
      >
        {text.slice(idx, idx + trimmed.length)}
      </mark>,
    );
    cursor = idx + trimmed.length;
    searchFrom = cursor;
    occurrence++;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

function DraggableSentence({
  sentence, active, dropActive, searchQuery, activeMatchKey, registerMatchRef,
  editing, editText, onStartEdit, onChangeText, onPeriodTyped, onCommit, onCancel,
}: {
  sentence: PlanSentenceRecord;
  active: boolean;
  dropActive: boolean;
  searchQuery: string;
  activeMatchKey: string | null;
  registerMatchRef: (key: string, el: HTMLElement | null) => void;
  editing: boolean;
  editText: string;
  onStartEdit: () => void;
  onChangeText: (value: string) => void;
  onPeriodTyped: (leftText: string, rightText: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform } = useDraggable({ id: `sentence:${sentence.id}`, disabled: editing });
  // The merge drop target is deliberately just the grip handle, NOT the
  // whole row — the row's own group still uses the whole area for "move
  // into this still" (DroppableStill). Sharing one hit area for both made
  // it a coin flip whether dropping a sentence near another one moved it
  // into that still or merged it with that specific sentence. A small,
  // separate handle-only target (paired with pointerWithin collision
  // detection on the DndContext) makes the two gestures physically
  // distinct: drop anywhere in a still to move there, drop precisely on
  // another sentence's handle to merge with it.
  const { setNodeRef: setMergeDropRef, isOver: isMergeOver } = useDroppable({ id: `sentence:${sentence.id}` });
  const editableRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!editing || !editableRef.current) return;
    const el = editableRef.current;
    el.textContent = editText;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Only re-sync when entering edit mode, not on every editText change —
    // contentEditable owns its own DOM content while focused; re-writing
    // textContent from React state on every keystroke would reset the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const mergeTargetActive = dropActive || isMergeOver;
  return <div
    ref={setDragRef}
    className={[active && "dragging", "sentence"].filter(Boolean).join(" ")}
    style={{ transform: CSS.Translate.toString(transform), touchAction: "none" }}
    {...(editing ? {} : listeners)}
    {...(editing ? {} : attributes)}
  >
    <b
      ref={setMergeDropRef}
      className={mergeTargetActive ? "merge-handle drag-over" : "merge-handle"}
      title="Drag another sentence here to merge it with this one"
    ><GripVertical size={18} /></b>
    {editing ? (
      <span
        ref={editableRef}
        className="sentence-edit-inline"
        contentEditable
        suppressContentEditableWarning
        onInput={(event) => {
          const text = event.currentTarget.textContent ?? "";
          onChangeText(text);
          // Only treat this as "split here" when a period was just TYPED —
          // checking the native InputEvent's inputType/data, not re-scanning
          // the whole text for "does a period exist anywhere" (that used to
          // misfire on backspace, or any edit, whenever the sentence already
          // had an unrelated period elsewhere — including its own normal
          // trailing full stop).
          const native = event.nativeEvent as InputEvent;
          if (native.inputType !== "insertText" || native.data !== ".") return;
          const selection = window.getSelection();
          const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
          const offset = range && range.endContainer.nodeType === Node.TEXT_NODE ? range.endOffset : null;
          if (offset === null || text.slice(offset).trim().length === 0) return;
          // Sliced from this live DOM text (which already includes the
          // period just typed, plus anything else edited this session) —
          // never re-applied as an offset against server-side text later.
          onPeriodTyped(text.slice(0, offset), text.slice(offset));
        }}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          else if (event.key === "Escape") { event.preventDefault(); onCancel(); }
        }}
      />
    ) : (
      <span onDoubleClick={onStartEdit} title="Double-click to edit">
        {highlightSentenceText(sentence.text, searchQuery, sentence.id, activeMatchKey, registerMatchRef)}
      </span>
    )}
    <small>{formatTimeShort(sentence.startSeconds)}</small>
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

export function GenerationProgress({ progress }: { progress: { percent: number; stage: string; detail: string } }) {
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
  if (stage === "visual-plan") return <VisualPlanView />;
  return <InputsView />;
}

type ImageSettings = {
  aspectRatio: string;
  // Basic
  cameraAngle: string;
  lighting: string;
  mood: string;
  depthOfField: string;
  colorTemperature: string;
  weatherAtmosphere: string;
  // Advanced
  lensType: string;
  lightDirection: string;
  lightQuality: string;
  shadowType: string;
  contrast: string;
  focusType: string;
  exposure: string;
  motion: string;
  composition: string;
  saturation: string;
  vignette: string;
  grainIntensity: string;
  colorCastTint: string;
  surfaceEffects: string;
};
const defaultImageSettings: ImageSettings = {
  aspectRatio: "16:9",
  cameraAngle: "Undefined", lighting: "Undefined", mood: "Undefined",
  depthOfField: "Undefined", colorTemperature: "Undefined", weatherAtmosphere: "Undefined",
  lensType: "Undefined", lightDirection: "Undefined", lightQuality: "Undefined",
  shadowType: "Undefined", contrast: "Undefined", focusType: "Undefined",
  exposure: "Undefined", motion: "Undefined", composition: "Undefined",
  saturation: "Undefined", vignette: "Undefined", grainIntensity: "Undefined",
  colorCastTint: "Undefined", surfaceEffects: "Undefined",
};
function parseImageSettings(value?: string): ImageSettings {
  try { return { ...defaultImageSettings, ...(value ? JSON.parse(value) : {}) }; }
  catch { return defaultImageSettings; }
}

function mergeExtractedSettings(current: ImageSettings, extracted: Partial<Record<string, string>>): ImageSettings {
  const aliases: Record<string, keyof ImageSettings> = {
    // old field names → new equivalents for backward compat
    shotType: "cameraAngle",
    lensFeel: "lensType",
    motionFeel: "motion",
    colorPalette: "colorTemperature",
    colorTreatment: "saturation",
    lens: "lensType",
    colorGrade: "saturation",
  };
  const presets: Partial<Record<keyof ImageSettings, string[]>> = {
    cameraAngle: ["Wide Shot","Medium Shot","Close Up","Extreme Close Up","Birds Eye View","Worms Eye View","Low Angle","High Angle","Eye Level","Over the Shoulder","Dutch Angle","Establishing Shot","Point of View POV"],
    lighting: ["Natural Daylight","Golden Hour","Blue Hour Dusk","Overcast Soft Diffused","Studio Lighting","Backlit Silhouette","Low Key Dark","High Key Bright","Night Moonlit","Candlelight Firelight","Underwater Light Rays","Window Light","Neon Lit"],
    mood: ["Serene Peaceful","Tense Anxious","Dramatic Intense","Warm and Cozy","Cold Distant","Mysterious","Cheerful Upbeat","Melancholic","Eerie Unsettling","Nostalgic","Hopeful","Playful","Lonely Isolated","Triumphant"],
    depthOfField: ["Shallow Blurred Background","Deep Everything Sharp","Medium","Macro Extreme Close Focus","Tilt Shift","Bokeh Heavy"],
    colorTemperature: ["Very Warm Golden","Warm","Neutral","Cool","Very Cool Blue Tinted","Mixed Contrasting Warm Cool"],
    weatherAtmosphere: ["Clear","Foggy Misty","Rainy","Overcast Sky","Snowy","Hazy Dusty","Underwater Haze","Steamy Humid","Stormy"],
    lensType: ["Wide Angle","Standard Normal","Telephoto","Macro","Fisheye","Tilt Shift Lens","Anamorphic"],
    lightDirection: ["Front Lighting","Backlighting","Side Lighting","Top Lighting","Bottom Underlighting","Rim Lighting"],
    lightQuality: ["Soft Light","Hard Light","Diffused Light","Dappled Through Leaves or Water"],
    shadowType: ["Sharp Shadows","Soft Shadows","Long Shadows","No Shadows","Dappled Shadows"],
    contrast: ["High Contrast","Balanced Contrast","Low Contrast"],
    focusType: ["Sharp Focus","Soft Focus","Selective Focus","Rack Focus","Motion Tracked Focus"],
    exposure: ["Underexposed","Balanced Exposure","Overexposed","High Key Overexposure Stylistic"],
    motion: ["Static No Motion","Motion Blur","Freeze Frame","Long Exposure Effect","Panning Blur"],
    composition: ["Rule of Thirds","Center Composition","Symmetry","Asymmetry","Leading Lines","Diagonal Composition","Negative Space","Golden Ratio Spiral","Framed Layered Depth","Tight Framing","Open Airy Framing"],
    saturation: ["Highly Saturated Vivid","Natural","Muted","Desaturated","Black and White Greyscale"],
    vignette: ["None","Light Vignette","Heavy Vignette"],
    grainIntensity: ["None","Subtle","Moderate","Heavy"],
    colorCastTint: ["None","Green Tint","Blue Tint","Red Pink Tint","Purple Tint","Yellow Tint","Sepia Tint"],
    surfaceEffects: ["None","Reflections","Glare Lens Flare","Water Droplets Condensation","Glass Glare"],
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
  const presetValues = options.filter((opt) => opt !== "Custom...");
  const isCustom = !presetValues.includes(value);
  const customText = value.startsWith("Custom: ") ? value.slice(8) : value;
  const lastCustomRef = useRef<string>("");
  if (isCustom) {
    lastCustomRef.current = customText;
    return (
      <label className="setting-control">
        <span>{label}</span>
        <div className="custom-control">
          <input value={customText} onChange={(e) => onChange(e.target.value ? `Custom: ${e.target.value}` : "Custom: ")} placeholder={`Type ${label.toLowerCase()}`} />
          <button type="button" title="Back to options" onClick={() => onChange(presetValues[0] ?? "Undefined")}>×</button>
        </div>
      </label>
    );
  }
  return (
    <label className="setting-control">
      <span>{label}</span>
      <select value={value} onChange={(e) => { if (e.target.value === "Custom...") onChange(lastCustomRef.current ? `Custom: ${lastCustomRef.current}` : "Custom: "); else onChange(e.target.value); }}>
        {options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    </label>
  );
}

// Module-level: survives ImagesView mount/unmount so navigation doesn't kill an in-flight plan
let _planningVideoId: string | null = null;
let _planningPromise: Promise<import("./infrastructure/projects-client").BulkPlanResultRecord> | null = null;

// Bulk plan progress events forwarded outside component lifecycle
void listen<{ planned: number; total: number }>("bulk_plan_progress", (event) => {
  // Only used to update whichever ImagesView instance is mounted; the component's own listener handles this.
  void event;
});

function ImagesView() {
  const { activeVideoId, addToast, setStage } = useAppStore();
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [imageSettings, setImageSettings] = useState<ImageSettings>(defaultImageSettings);
  const settingsJson = JSON.stringify(imageSettings);
  const [tab, setTab] = useState<"prompt" | "settings" | "edit">("prompt");
  const [loading, setLoading] = useState(false);
  const [generatingGroupId, setGeneratingGroupId] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ImageJobRecord | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState<string | null>(null);
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
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
  const [bulkPlan, setBulkPlan] = useState<import("./infrastructure/projects-client").BulkPlanResultRecord | null>(null);
  const [bulkPlanLoading, setBulkPlanLoading] = useState(false);
  const [bulkInstruction, setBulkInstruction] = useState(() => localStorage.getItem("bulk_creative_instruction") ?? "");
  const [characterConsistency, setCharacterConsistency] = useState(() => localStorage.getItem("bulk_character_consistency") === "true");
  const [bulkOverviewOpen, setBulkOverviewOpen] = useState(false);
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
  useEffect(() => {
    function handleArrowNavigation(event: KeyboardEvent) {
      if (zoomOpen || editOpen) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      const groups = workspace?.groups;
      if (!groups?.length) return;
      const index = groups.findIndex((group) => group.group.id === selectedGroupId);
      if (index < 0) return;
      const next = groups[index + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) {
        event.preventDefault();
        selectGroup(next.group.id);
      }
    }
    window.addEventListener("keydown", handleArrowNavigation);
    return () => window.removeEventListener("keydown", handleArrowNavigation);
  }, [workspace, selectedGroupId, zoomOpen, editOpen]);

  useEffect(() => {
    async function loadWorkspace() {
      if (!activeVideoId) return;
      const cached = imageWorkspaceCache.get(activeVideoId);
      if (cached) {
        setWorkspace(cached);
        setSelectedGroupId((current) => {
          const restore = lastSelectedStill.get(activeVideoId);
          if (restore && cached.groups.some((g) => g.group.id === restore)) return restore;
          return current ?? cached.groups[0]?.group.id ?? null;
        });
      }
      setLoading(!cached);
      setError(null);
      try {
        const loaded = await projectsClient.getImageWorkspace(activeVideoId);
        setCached(activeVideoId, loaded);
        setWorkspace(loaded);
        setSelectedGroupId((current) => {
          const restore = lastSelectedStill.get(activeVideoId);
          if (restore && loaded.groups.some((g) => g.group.id === restore)) return restore;
          if (current && loaded.groups.some((g) => g.group.id === current)) return current;
          return loaded.groups[0]?.group.id ?? null;
        });
        setImageSettings(parseImageSettings(loaded.settings.find((setting) => setting.key === "image_settings")?.value));
        const inputs = await projectsClient.getVideoInputs(activeVideoId);
        setReferences(inputs.references);
        const latestJob = await projectsClient.getLatestImageJob(activeVideoId);
        setJob(latestJob && ["queued", "running", "paused", "stopped"].includes(latestJob.status) ? latestJob : null);
        const latest = loaded.groups[0]?.promptVersions[0];
        setSystemPrompt(loaded.settings.find((s) => s.key === "system_prompt")?.value ?? latest?.systemPrompt ?? "");
        setUserPrompt(latest?.userPrompt ?? "");
        const latestRender = loaded.groups[0]?.imageRenders[0];
        setSelectedRenderId(latestRender?.id ?? null);
        const savedPrep = loaded.settings.find((setting) => setting.key === `prompt_prep.${activeVideoId}`)?.value;
        if (savedPrep) {
          try {
            const saved = JSON.parse(savedPrep) as { status: string; index: number; settings: ImageSettings; styleDirective: string };
            if (saved.status === "paused" && saved.index < loaded.groups.length) {
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
      setJob(latest && ["queued", "running", "paused", "stopped"].includes(latest.status) ? latest : null);
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
      setCached(activeVideoId, loaded);
      setWorkspace(loaded);
      const selected = loaded.groups.find((group) => group.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest) setSelectedRenderId(newest.id);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function createVersion() {
    if (!activeVideoId || !selectedGroupId) return;
    const latest = selectedGroup?.promptVersions[0];
    const style = systemPrompt || "Preserve a coherent visual style.";
    const normalizeSettings = (json: string) => { try { return JSON.stringify(parseImageSettings(json)); } catch { return json; } };
    const sameSettings = latest ? normalizeSettings(latest.settingsJson) === normalizeSettings(settingsJson) : false;
    if (!userPrompt.trim() || (latest?.userPrompt === userPrompt && latest?.systemPrompt === style && sameSettings)) return;
    try {
      await projectsClient.createPromptVersion(
        activeVideoId,
        selectedGroupId,
        settingsJson,
        style,
        userPrompt,
      );
      await refreshWorkspace();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function generateRender() {
    if (!activeVideoId || !selectedGroupId) return;
    setGeneratingGroupId(selectedGroupId);
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
      setGeneratingGroupId(null);
    }
  }

  const [confirmingStop, setConfirmingStop] = useState(false);

  async function controlJob(action: "pause" | "resume" | "stop" | "cancel") {
    if (!job) return;
    try {
      setJob(await projectsClient.controlImageJob(job.id, action));
    } catch (caught) {
      setError(String(caught));
    }
  }

  function selectGroup(groupId: string) {
    setError(null);
    setSelectedGroupId(groupId);
    if (activeVideoId) lastSelectedStill.set(activeVideoId, groupId);
    const latest = workspace?.groups.find((item) => item.group.id === groupId)?.promptVersions[0];
    const globalDirective = workspace?.settings.find((s) => s.key === "system_prompt")?.value;
    setSystemPrompt(globalDirective ?? latest?.systemPrompt ?? "");
    setUserPrompt(latest?.userPrompt ?? "");
    setImageSettings(parseImageSettings(latest?.settingsJson));
    const latestRender = workspace?.groups.find((item) => item.group.id === groupId)?.imageRenders[0];
    setSelectedRenderId(latestRender?.id ?? null);
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
          await projectsClient.createPromptVersion(activeVideoId, item.group.id, perStillJson, systemPrompt || "Preserve a coherent visual style.", planned.userPrompt);
          if (item.group.id === selectedGroupId) {
            setImageSettings(perStill);
            setUserPrompt(planned.userPrompt);
          }
        }
        const live = await projectsClient.getImageWorkspace(activeVideoId);
        setCached(activeVideoId, live);
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
          status: "running", index: index + 1, strategyMode: "Auto Educational",
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
          status: "paused", index: task.index, strategyMode: "Auto Educational",
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
        status: "paused", index: promptPrepTask.current.index, strategyMode: "Auto Educational",
        settings: imageSettings, styleDirective: systemPrompt,
      }));
    }
  }

  function controlPromptPreparation(action: "pause" | "resume" | "stop") {
    if (action === "pause") {
      promptPrepControl.current = "paused";
      setPromptPrepStatus("paused");
      if (promptPrepSettingKey && promptPrepTask.current) void projectsClient.saveAppSetting(promptPrepSettingKey, JSON.stringify({
        status: "paused", index: promptPrepTask.current.index, strategyMode: "Auto Educational",
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
    setAiLoading(true);
    setError(null);
    try {
      const planned = await projectsClient.suggestStillPrompt(activeVideoId, selectedGroupId, systemPrompt, settingsJson);
      setUserPrompt(planned.userPrompt);
      setImageSettings((current) => mergeExtractedSettings(current, planned.imageSettings));
      await refreshWorkspace();
    } catch (caught) { setError(String(caught)); }
    finally { setAiLoading(false); }
  }

  async function extractImageSettingsFromDirective() {
    if (!systemPrompt.trim()) return;
    setAiLoading(true);
    setError(null);
    try {
      const result = await projectsClient.extractImageSettingsFromDirective(systemPrompt);
      setSystemPrompt(result.styleDirective);
      setImageSettings((current) => mergeExtractedSettings(current, result.imageSettings));
      setTab("settings");
    } catch (caught) { setError(String(caught)); }
    finally { setAiLoading(false); }
  }

  // Keep progress events alive while component is mounted
  useEffect(() => {
    const unlisten = listen<{ planned: number; total: number }>("bulk_plan_progress", (event) => {
      setBulkProgress((prev) => prev ? { ...prev, current: event.payload.planned, total: event.payload.total } : null);
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  // Reattach to an in-flight plan if the user navigated away and came back
  useEffect(() => {
    if (_planningPromise && _planningVideoId === activeVideoId) {
      setBulkPlanLoading(true);
      setBulkProgress({ current: 0, total: 0, label: "Planning stills with AI…" });
      void _planningPromise
        .then((plan) => { setBulkPlan(plan); setBulkOverviewOpen(true); })
        .catch((err: unknown) => { setError(String(err)); setBulkOpen(true); })
        .finally(() => { setBulkPlanLoading(false); setBulkProgress(null); });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoId]);

  async function runBulkPlan() {
    if (!activeVideoId || !workspace || _planningPromise) return;
    const total = workspace.groups.length;
    setBulkOpen(false);
    setBulkPlanLoading(true);
    setBulkProgress({ current: 0, total: 0, label: `Planning ${total} stills with AI…` });
    setError(null);
    _planningVideoId = activeVideoId;
    const innerPromise = (async () => {
      await projectsClient.saveAppSetting("system_prompt", systemPrompt);
      return projectsClient.planBulkVisuals(activeVideoId, systemPrompt, settingsJson, bulkInstruction, characterConsistency);
    })();
    _planningPromise = innerPromise;
    try {
      const plan = await innerPromise;
      setBulkPlan(plan);
      setBulkOverviewOpen(true);
    } catch (caught) {
      setError(String(caught));
      setBulkOpen(true);
    } finally {
      setBulkPlanLoading(false);
      setBulkProgress(null);
      _planningPromise = null;
      _planningVideoId = null;
    }
  }

  async function approveBulkPlan() {
    if (!activeVideoId || !bulkPlan) return;
    setLoading(true);
    setError(null);
    try {
      setBulkOverviewOpen(false);
      await projectsClient.approveBulkPlan(activeVideoId, systemPrompt, bulkPlan.stills);
      const live = await projectsClient.getImageWorkspace(activeVideoId);
      setCached(activeVideoId, live);
      setWorkspace(live);
      if (selectedGroupId) {
        const group = live.groups.find((g) => g.group.id === selectedGroupId);
        const pv = group?.promptVersions[0];
        if (pv) {
          setImageSettings(parseImageSettings(pv.settingsJson));
          setUserPrompt(pv.userPrompt);
          const globalDirective = live.settings.find((s) => s.key === "system_prompt")?.value;
          setSystemPrompt(globalDirective ?? pv.systemPrompt ?? systemPrompt);
        }
      }
      setBulkPlan(null);
      // Planning and generating are one action from the user's perspective —
      // approving the plan immediately kicks off rendering for every still.
      const newJob = await projectsClient.createImageJob(activeVideoId);
      setJob(newJob);
    } catch (caught) { setError(String(caught)); }
    finally { setLoading(false); }
  }

  function updateImageSetting<K extends keyof ImageSettings>(key: K, value: ImageSettings[K]) {
    setImageSettings((current) => ({ ...current, [key]: value }));
  }

  // Auto-save image settings whenever they change (replaces the removed "Apply settings" button)
  useEffect(() => {
    if (!activeVideoId) return;
    const timer = window.setTimeout(() => {
      void projectsClient.saveAppSetting("image_settings", settingsJson);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [settingsJson, activeVideoId]);

  async function downloadStill(renderId: string) {
    try {
      let folder = await projectsClient.getAppSetting("download_folder");
      if (!folder) {
        folder = await projectsClient.pickDownloadFolder();
        if (!folder) return;
        await projectsClient.saveAppSetting("download_folder", folder);
      }
      const fileName = await projectsClient.copyRenderToFolder(renderId, folder);
      addToast(`Saved: ${fileName}`, "success");
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function importReference() {
    if (!activeVideoId) return;
    if (references.length) await removeReference(references[0].id);
    const asset = await projectsClient.pickAndImportAsset(activeVideoId, "reference");
    if (asset) {
      setReferences([asset]);
      setReferenceUrl(await resolveAssetUrl(asset.id));
    }
  }

  useEffect(() => {
    const reference = references[0];
    if (!reference) return;
    void resolveAssetUrl(reference.id).then(setReferenceUrl).catch(() => setReferenceUrl(""));
  }, [references]);

  async function removeReference(assetId: string) {
    await projectsClient.removeInputAsset(assetId);
    setReferences((items) => items.filter((item) => item.id !== assetId));
    setReferenceUrl("");
  }

  async function extractStyle(assetId: string) {
    setAiLoading(true);
    setError(null);
    try {
      const extracted = await projectsClient.extractReferenceStyle(assetId);
      setSystemPrompt(extracted.styleDirective);
      setImageSettings((current) => mergeExtractedSettings(current, extracted.imageSettings));
      setTab("settings");
    } catch (caught) { setError(String(caught)); }
    finally { setAiLoading(false); }
  }

  const previewLabel = selectedGroup?.group.label ?? "Still preview";
  const stillCount = workspace?.groups.length ?? 0;
  const imageRenders = selectedGroup?.imageRenders ?? [];

  useEffect(() => {
    const ids = [selectedRenderId].filter(Boolean) as string[];
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [selectedRenderId, renderUrls]);

  useEffect(() => {
    const ids = workspace?.groups.map((group) => group.imageRenders[0]?.id).filter(Boolean) as string[] | undefined;
    if (!ids?.length) return;
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [workspace, renderUrls]);

  async function editSelectedRender() {
    if (!selectedRenderId || !editInstruction.trim()) return;
    setEditOpen(false);
    setLoading(true);
    setError(null);
    try {
      const canvas = maskCanvasRef.current;
      const maskDataUrl = canvas && canvas.dataset.painted === "true" ? canvas.toDataURL("image/png") : undefined;
      const edited = await projectsClient.editImageRender(selectedRenderId, editInstruction.trim(), maskDataUrl, editStrength);
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
    setSelectedRenderId(render.id);
    // The version the user navigates to becomes the one used downstream
    // (export/timeline), so browsing to it also marks it final — no
    // separate "Mark final" action needed.
    if (!activeVideoId || render.isFinal) return;
    void (async () => {
      try {
        await projectsClient.setFinalRender(render.id, true);
        const loaded = await projectsClient.getImageWorkspace(activeVideoId);
        setCached(activeVideoId, loaded);
        setWorkspace(loaded);
      } catch (caught) { setError(String(caught)); }
    })();
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

  async function doResetImages() {
    if (!activeVideoId) return;
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
      setUserPrompt("");
      setSystemPrompt("");
      setImageSettings(defaultImageSettings);
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      setCached(activeVideoId, loaded);
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
      if (result) addToast(`Exported ${result.fileCount} stills to ${result.path}`, "success");
    } catch (caught) { setError(String(caught)); }
  }

  const [applyingStyle, setApplyingStyle] = useState(false);
  async function applyStyleToAll() {
    if (!activeVideoId || !systemPrompt.trim()) return;
    setApplyingStyle(true);
    try {
      const count = await projectsClient.applyStyleDirectiveToAll(activeVideoId, systemPrompt);
      addToast(`Style directive applied to ${count} prompt version${count !== 1 ? "s" : ""}.`, "success");
    } catch (caught) { setError(String(caught)); }
    finally { setApplyingStyle(false); }
  }

  return (
    <section className="view images-view">
      {loading && <LoadingOverlay label="Working on your images" />}
      {confirmReset && <ConfirmDialog title="Reset all images?" message="This clears all prompts, image versions, planner results, and still statuses for this video. This cannot be undone." confirmLabel="Reset everything" onConfirm={() => { setConfirmReset(false); void doResetImages(); }} onCancel={() => setConfirmReset(false)} />}
      {confirmingStop && <ConfirmDialog title="Stop bulk generation?" message="This will permanently stop the current job. Any stills already generated are kept, but remaining stills will not be generated and the job cannot be resumed." confirmLabel="Stop generation" onConfirm={() => { setConfirmingStop(false); void controlJob("cancel"); }} onCancel={() => setConfirmingStop(false)} />}
      <div className="page-heading">
        <div>
          <h1>Image generation</h1>
          <p>Select a still, review prompt versions, and generate render outputs.</p>
        </div>
        <div className="heading-actions"><button className="secondary" onClick={() => setBulkOpen(true)} disabled={!workspace?.groups.length || loading}><WandSparkles size={17} />Bulk Gen Config</button><button className="primary" onClick={() => setStage("timeline")} disabled={!workspace?.groups.length}><Film size={17} />Continue to timeline →</button></div>
      </div>
      {error && <div className="error-toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
      <div className="image-workspace">
        <aside className="stills">
          <div className="stills-heading">
            <div className="stills-heading-left">
              <span className="stills-heading-label">Stills</span>
              <span className="stills-heading-count">{stillCount}</span>
            </div>
            <div className="stills-heading-actions">
              <button className="icon-button" title="Download all" aria-label="Download all" onClick={() => void exportStills()}><Download size={15} /></button>
              <button className="icon-button danger-action" title="Reset images" aria-label="Reset images" onClick={() => setConfirmReset(true)} disabled={loading}><Trash2 size={15} /></button>
            </div>
          </div>
          <div className="still-list">
            {(workspace?.groups ?? []).map((group) => {
              const newestPrompt = group.promptVersions[0];
              const newestRender = group.imageRenders[0];
              const isSelectedGroup = group.group.id === selectedGroupId;
              const thumbUrl = isSelectedGroup && selectedRenderId
                ? renderUrls[selectedRenderId]
                : newestRender ? renderUrls[newestRender.id] : undefined;
              const item = job?.items.find((candidate) => candidate.groupId === group.group.id);
              const isPreparing = preparingGroupIds.has(group.group.id);
              const isGenerating = item?.status === "running" || generatingGroupId === group.group.id;
              const statusKey = isPreparing || isGenerating ? "generating" : item?.status === "failed" ? "failed" : newestRender && newestPrompt && newestRender.promptVersionId !== newestPrompt.id ? "outdated" : newestRender ? "generated" : newestPrompt ? "ready" : "empty";
              const statusLabel = isPreparing ? "Preparing prompt" : isGenerating ? "Generating" : statusKey === "failed" ? "Failed" : statusKey === "outdated" ? "Outdated — regenerate" : statusKey === "generated" ? "Generated" : statusKey === "ready" ? "Prompt ready" : "No prompt yet";
              return (
                <button
                  key={group.group.id}
                  className={`still-select${group.group.id === selectedGroupId ? " active" : ""}`}
                  title={statusLabel}
                  onClick={() => selectGroup(group.group.id)}
                >
                  <div className={`still-thumb ${imageSettings.aspectRatio === "9:16" ? "portrait" : "landscape"}${thumbUrl ? "" : " empty"}`}>
                    {thumbUrl ? <img src={thumbUrl} alt={`Still ${group.group.ordinal} preview`} /> : <div className="still-thumb-empty"><Image size={18} /><span>No image generated yet</span></div>}
                    <span className="still-number">{group.group.ordinal}</span>
                    {statusKey !== "empty" && (
                      <span className={`still-status-badge ${statusKey}`} aria-label={statusLabel}>
                        {statusKey === "generated" && <Check size={11} />}
                        {statusKey === "ready" && <Sparkles size={11} />}
                        {statusKey === "generating" && <LoaderCircle size={11} className="spin" />}
                        {statusKey === "failed" && <X size={11} />}
                        {statusKey === "outdated" && <Undo2 size={11} />}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {!workspace && <div className="empty-state">Loading stills…</div>}
        </aside>
        <div className="preview">
          {job && !bulkProgress && (
            <div className="job-status">
              <div><strong>Bulk job: {job.status}</strong><span>{job.completedItems}/{job.totalItems} completed · {job.failedItems} failed</span></div>
              <progress value={job.completedItems + job.failedItems} max={job.totalItems} />
              <div>
                {["queued", "running"].includes(job.status) && <button className="secondary" onClick={() => void controlJob("pause")}>Pause</button>}
                {job.status === "paused" && <button className="secondary" onClick={() => void controlJob("resume")}>Resume</button>}
                {["queued", "running", "paused"].includes(job.status) && <button className="secondary" onClick={() => setConfirmingStop(true)}>Stop</button>}
              </div>
            </div>
          )}
          {bulkProgress && <div className="bulk-live-progress"><div><strong>{bulkProgress.label}</strong>{bulkProgress.total > 0 && <span>{bulkProgress.current} / {bulkProgress.total}</span>}</div>{bulkProgress.total > 0 ? <progress value={bulkProgress.current} max={bulkProgress.total} /> : <progress />}{bulkProgress.total > 0 && <div className="prompt-progress-actions">{promptPrepStatus === "running" && <button className="secondary" onClick={() => controlPromptPreparation("pause")}>Pause</button>}{promptPrepStatus === "paused" && <button className="secondary" onClick={() => controlPromptPreparation("resume")}>Resume</button>}<button className="secondary" onClick={() => controlPromptPreparation("stop")}>Stop</button></div>}</div>}
          <header>
            <div><span className="timestamp-heading">{selectedTiming ? `${formatTimeShort(selectedTiming.start)} – ${formatTimeShort(selectedTiming.end)}` : previewLabel}</span><strong className="production-copy narration-preview">{selectedSentences.map((sentence) => sentence.text).join(" ")}</strong></div>
          </header>
          <div className="preview-art">
            {selectedRenderId && renderUrls[selectedRenderId] ? (
              <figure className={`image-frame clickable-frame ${imageSettings.aspectRatio === "9:16" ? "portrait" : "landscape"}`}>
                <img src={renderUrls[selectedRenderId]} alt="Selected image version" onClick={() => { setZoom(1); setZoomOpen(true); }} />
                <div className="image-actions">
                  <button className="image-action-btn" title="Download this image" onClick={() => { if (selectedRenderId) void downloadStill(selectedRenderId); }}><Download size={16} /><span>Download</span></button>
                </div>
              </figure>
            ) : <div className={`image-frame empty-frame ${imageSettings.aspectRatio === "9:16" ? "portrait" : "landscape"}`}><div className="image-empty"><Image size={34} /><strong>No image generated yet</strong><span>{imageSettings.aspectRatio === "9:16" ? "YouTube Short · 9:16" : "YouTube Video · 16:9"}</span></div></div>}
          </div>
          <footer>
            <div className="version-nav"><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) >= imageRenders.length - 1} onClick={() => moveVersion(1)}><ChevronLeft size={16} />Older</button><strong>{selectedRenderId ? `Version ${imageRenders.find((r) => r.id === selectedRenderId)?.version} / ${imageRenders.length}` : "No versions"}</strong><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) <= 0} onClick={() => moveVersion(-1)}>Newer<ChevronRight size={16} /></button></div>
          </footer>
        </div>
        <aside className="prompt-panel">
          <div className="tabs" role="tablist" onKeyDown={(e) => {
            const tabs: Array<"prompt" | "settings" | "edit"> = ["prompt", "settings", "edit"];
            const idx = tabs.indexOf(tab);
            if (e.key === "ArrowRight") { e.preventDefault(); setTab(tabs[(idx + 1) % tabs.length]); }
            if (e.key === "ArrowLeft") { e.preventDefault(); setTab(tabs[(idx - 1 + tabs.length) % tabs.length]); }
          }}>
            <button role="tab" aria-selected={tab === "prompt"} className={tab === "prompt" ? "active" : ""} onClick={() => setTab("prompt")}>Prompt</button>
            <button role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}>Settings</button>
            <button role="tab" aria-selected={tab === "edit"} className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>Edit / Inpaint</button>
          </div>
          {tab === "prompt" ? (
            <div className="prompt-fields">
              <label>
                <span className="field-heading">User Prompt</span>
                <textarea className="production-copy" value={userPrompt} onChange={(event) => setUserPrompt(event.target.value)} onBlur={() => void createVersion()} placeholder="Describe the scene that directly supports this narration." />
              </label>
              <button className="secondary full" onClick={() => void suggestPrompt()} disabled={!selectedGroupId || aiLoading}>{aiLoading ? <><LoaderCircle className="spin" size={14} />Suggesting…</> : <><Sparkles size={15} />Suggest Prompt</>}</button>
              <label>
                <span className="field-heading">Style Directive <small>Optional</small></span>
                <textarea className="production-copy" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Art style, rendering, color language, recurring subjects, visual consistency rules..." />
              </label>
              <button
                type="button"
                className="text-button style-apply-all"
                onClick={() => void applyStyleToAll()}
                disabled={applyingStyle || !systemPrompt.trim() || !workspace?.groups.length}
                title="Updates this style directive on every still's existing prompt version, without re-planning"
              >
                {applyingStyle ? <><LoaderCircle className="spin" size={13} />Applying to all stills…</> : <><WandSparkles size={13} />Apply this style to all stills</>}
              </button>
              <button className="primary full generate-image-btn" onClick={() => void generateRender()} disabled={!selectedGroupId || !userPrompt.trim() || !!generatingGroupId}>{generatingGroupId === selectedGroupId ? <><LoaderCircle className="spin" size={14} />Generating…</> : "Generate Image"}</button>
            </div>
          ) : tab === "settings" ? (
            <>
              <div className="panel-section-heading"><h3>Image settings</h3><small>Per still</small></div>
              <SettingSelect label="Aspect Ratio" value={imageSettings.aspectRatio} options={["16:9","9:16"]} onChange={(value) => updateImageSetting("aspectRatio", value)} />
              <div className="setting-grid" style={{marginTop:"10px"}}>
                <SettingSelect label="Camera Angle" value={imageSettings.cameraAngle} options={["Undefined","Wide Shot","Medium Shot","Close Up","Extreme Close Up","Birds Eye View","Worms Eye View","Low Angle","High Angle","Eye Level","Over the Shoulder","Dutch Angle","Establishing Shot","Point of View POV","Custom..."]} onChange={(value) => updateImageSetting("cameraAngle", value)} />
                <SettingSelect label="Lighting" value={imageSettings.lighting} options={["Undefined","Natural Daylight","Golden Hour","Blue Hour Dusk","Overcast Soft Diffused","Studio Lighting","Backlit Silhouette","Low Key Dark","High Key Bright","Night Moonlit","Candlelight Firelight","Underwater Light Rays","Window Light","Neon Lit","Custom..."]} onChange={(value) => updateImageSetting("lighting", value)} />
                <SettingSelect label="Mood" value={imageSettings.mood} options={["Undefined","Serene Peaceful","Tense Anxious","Dramatic Intense","Warm and Cozy","Cold Distant","Mysterious","Cheerful Upbeat","Melancholic","Eerie Unsettling","Nostalgic","Hopeful","Playful","Lonely Isolated","Triumphant","Custom..."]} onChange={(value) => updateImageSetting("mood", value)} />
                <SettingSelect label="Depth of Field" value={imageSettings.depthOfField} options={["Undefined","Shallow Blurred Background","Deep Everything Sharp","Medium","Macro Extreme Close Focus","Tilt Shift","Bokeh Heavy","Custom..."]} onChange={(value) => updateImageSetting("depthOfField", value)} />
                <SettingSelect label="Color Temperature" value={imageSettings.colorTemperature} options={["Undefined","Very Warm Golden","Warm","Neutral","Cool","Very Cool Blue Tinted","Mixed Contrasting Warm Cool","Custom..."]} onChange={(value) => updateImageSetting("colorTemperature", value)} />
                <SettingSelect label="Weather / Atmosphere" value={imageSettings.weatherAtmosphere} options={["Undefined","Clear","Foggy Misty","Rainy","Overcast Sky","Snowy","Hazy Dusty","Underwater Haze","Steamy Humid","Stormy","Custom..."]} onChange={(value) => updateImageSetting("weatherAtmosphere", value)} />
              </div>
              <details className="advanced-settings"><summary><span><strong>Advanced</strong><small>Lens, light, composition, effects</small></span><b>＋</b></summary><div className="setting-grid">
                {([
                  ["lensType","Lens Type",["Undefined","Wide Angle","Standard Normal","Telephoto","Macro","Fisheye","Tilt Shift Lens","Anamorphic","Custom..."]],
                  ["lightDirection","Light Direction",["Undefined","Front Lighting","Backlighting","Side Lighting","Top Lighting","Bottom Underlighting","Rim Lighting","Custom..."]],
                  ["lightQuality","Light Quality",["Undefined","Soft Light","Hard Light","Diffused Light","Dappled Through Leaves or Water","Custom..."]],
                  ["shadowType","Shadow Type",["Undefined","Sharp Shadows","Soft Shadows","Long Shadows","No Shadows","Dappled Shadows","Custom..."]],
                  ["contrast","Contrast",["Undefined","High Contrast","Balanced Contrast","Low Contrast","Custom..."]],
                  ["focusType","Focus Type",["Undefined","Sharp Focus","Soft Focus","Selective Focus","Rack Focus","Motion Tracked Focus","Custom..."]],
                  ["exposure","Exposure",["Undefined","Underexposed","Balanced Exposure","Overexposed","High Key Overexposure Stylistic","Custom..."]],
                  ["motion","Motion",["Undefined","Static No Motion","Motion Blur","Freeze Frame","Long Exposure Effect","Panning Blur","Custom..."]],
                  ["composition","Composition",["Undefined","Rule of Thirds","Center Composition","Symmetry","Asymmetry","Leading Lines","Diagonal Composition","Negative Space","Golden Ratio Spiral","Framed Layered Depth","Tight Framing","Open Airy Framing","Custom..."]],
                  ["saturation","Saturation",["Undefined","Highly Saturated Vivid","Natural","Muted","Desaturated","Black and White Greyscale","Custom..."]],
                  ["vignette","Vignette",["Undefined","None","Light Vignette","Heavy Vignette","Custom..."]],
                  ["grainIntensity","Grain Intensity",["Undefined","None","Subtle","Moderate","Heavy","Custom..."]],
                  ["colorCastTint","Color Cast / Tint",["Undefined","None","Green Tint","Blue Tint","Red Pink Tint","Purple Tint","Yellow Tint","Sepia Tint","Custom..."]],
                  ["surfaceEffects","Surface Effects",["Undefined","None","Reflections","Glare Lens Flare","Water Droplets Condensation","Glass Glare","Custom..."]],
                ] as [keyof ImageSettings,string,string[]][]).map(([key,label,options]) => <SettingSelect key={key} label={label} value={imageSettings[key]} options={options} onChange={(value) => updateImageSetting(key, value)} />)}
              </div></details>
              <div className="reference-manager">
                <div><strong>Visual references</strong><span>Style or subject guidance — Extract Style updates the Style Directive.</span></div>
                {!references.length && <button className="secondary" onClick={() => void importReference()}><Plus size={14} />Add image</button>}
                {references.map((reference) => <div className="reference-item" key={reference.id}>{referenceUrl ? <img src={referenceUrl} alt="Visual reference" /> : <span>IMG</span>}<button title="Extract Style" onClick={() => void extractStyle(reference.id)} disabled={aiLoading}><Sparkles size={13} />Extract Style</button><button onClick={() => void removeReference(reference.id)} aria-label={`Remove ${reference.originalName}`}><X size={13} /></button></div>)}
              </div>
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
          <div className="lightbox-toolbar"><strong>Image inspection</strong><button onClick={() => setZoom((value) => Math.max(.25, value - .25))}><ZoomOut size={17} /></button><button onClick={() => setZoom(1)}>Reset</button><button onClick={() => setZoom((value) => Math.min(5, value + .25))}><ZoomIn size={17} /></button><button onClick={() => setZoomOpen(false)}><X size={17} /></button></div>
          <div className="lightbox-canvas"><img src={renderUrls[selectedRenderId]} alt="Zoomed selected version" style={{ transform: `scale(${zoom})` }} onClick={() => setZoomOpen(false)} /></div>
        </div>
      </div>}
      {editOpen && selectedRenderId && renderUrls[selectedRenderId] && <div className="modal-backdrop image-lightbox">
        <div className="edit-modal">
          <div className="lightbox-toolbar"><strong>Edit / Inpaint</strong><button className={eraseMask && !editPanMode ? "active" : ""} onClick={() => { setEraseMask((current) => !current); setEditPanMode(false); }}>{eraseMask ? "Paint mask" : "Erase mask"}</button><button className={editPanMode ? "active" : ""} onClick={() => setEditPanMode((current) => !current)}>Pan</button><button onClick={() => setEditZoom((value) => Math.max(.5, value - .25))}><ZoomOut size={16} /></button><button onClick={() => { setEditZoom(1); setEditPan({ x: 0, y: 0 }); }}>Fit</button><button onClick={() => setEditZoom((value) => Math.min(4, value + .25))}><ZoomIn size={16} /></button><button onClick={clearMask}>Clear mask</button><button onClick={() => setEditOpen(false)}><X size={17} /></button></div>
          <div className="edit-body">
            <div className={editPanMode ? "mask-stage panning" : "mask-stage"} onPointerDown={(event) => { if (editPanMode) panStartRef.current = { x: event.clientX, y: event.clientY, originX: editPan.x, originY: editPan.y }; }} onPointerMove={(event) => { const start = panStartRef.current; if (editPanMode && start) setEditPan({ x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y }); }} onPointerUp={() => { panStartRef.current = null; }}>
              <div className={`mask-transform ${imageSettings.aspectRatio === "9:16" ? "portrait" : ""}`} style={{ transform: `translate(${editPan.x}px, ${editPan.y}px) scale(${editZoom})` }}>
                <img src={renderUrls[selectedRenderId]} alt="Source image for editing" />
                <canvas ref={maskCanvasRef} aria-label="Mask painting canvas — paint over areas to edit" width={imageSettings.aspectRatio === "9:16" ? 720 : 1280} height={imageSettings.aspectRatio === "9:16" ? 1280 : 720} onPointerDown={(event) => { if (editPanMode) return; paintingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); paintMask(event); }} onPointerMove={(event) => { if (!editPanMode) paintMask(event); }} onPointerUp={() => { paintingRef.current = false; }} />
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
      {bulkOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setBulkOpen(false)}>
        <div className="modal bulk-modal" onMouseDown={(e) => e.stopPropagation()}>
          <h2>Bulk Gen Config</h2>
          <div className="panel-section-heading" style={{marginTop:"4px"}}><h3>Style Directive</h3><small>Global visual style</small></div>
          <p style={{fontSize:"12px",color:"var(--text-muted)",margin:"0 0 8px"}}>Describe overall cinematography and visual language. Avoid scene-specific details — the AI will handle those per still.</p>
          <textarea className="bulk-directive" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="e.g. Cinematic documentary style, shallow depth of field, warm color grade, soft natural lighting…" rows={4} />
          <button className="secondary full" style={{marginTop:"6px"}} onClick={() => void extractImageSettingsFromDirective()} disabled={aiLoading || !systemPrompt.trim()}>{aiLoading ? <><LoaderCircle className="spin" size={13} />Analyzing…</> : <><Sparkles size={14} />Readjust to global settings only</>}</button>
          <div className="panel-section-heading" style={{marginTop:"18px"}}><h3>Reference Image</h3><small>Optional</small></div>
          <p style={{fontSize:"12px",color:"var(--text-muted)",margin:"0 0 8px"}}>Upload a reference to extract visual style and populate the directive automatically.</p>
          <div className="reference-list bulk-ref-list">
            {references.map((reference) => (
              <div className="reference-item" key={reference.id}>
                {referenceUrl ? <img src={referenceUrl} alt="Visual reference" /> : <span>IMG</span>}
                <button onClick={() => void extractStyle(reference.id)} disabled={aiLoading}><Sparkles size={13} />Extract Style</button>
                <button onClick={() => void removeReference(reference.id)} aria-label={`Remove ${reference.originalName}`}><X size={13} /></button>
              </div>
            ))}
            <button className="secondary" onClick={() => void importReference()}><Plus size={14} />{references.length ? "Replace image" : "Upload reference image"}</button>
          </div>
          <div className="panel-section-heading" style={{marginTop:"18px"}}><h3>Character Consistency</h3><small>Optional</small></div>
          <label className="toggle-setting" style={{padding:"6px 0"}}>
            <span>
              Keep one character consistent across all stills
              <small>AI derives a character from your reference image and weaves it into every applicable still's prompt.</small>
            </span>
            <input
              type="checkbox"
              checked={characterConsistency}
              onChange={(event) => { setCharacterConsistency(event.target.checked); localStorage.setItem("bulk_character_consistency", String(event.target.checked)); }}
            />
          </label>
          {characterConsistency && !references.length && (
            <p style={{fontSize:"11px",color:"var(--muted)",margin:"2px 0 0"}}>Upload a reference image above — Character Consistency needs one to work from.</p>
          )}
          <div className="panel-section-heading" style={{marginTop:"18px"}}><h3>Creative Instructions</h3><small>Optional</small></div>
          <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 8px",lineHeight:"1.55"}}>Hard rules applied to <strong>every</strong> still. Positive rules (always include X, use Y) are woven into the scene description. Negative rules (avoid X, no Y) are extracted and appended to the prompt as <code>[Avoid: ...]</code>.</p>
          <textarea className="bulk-directive" value={bulkInstruction} onChange={(e) => { setBulkInstruction(e.target.value); localStorage.setItem("bulk_creative_instruction", e.target.value); }} placeholder="e.g. Always include the orange cat as the main character. Show visible emotions and varied body language. Avoid showing text, labels, or close-ups on faces." rows={4} />
          <button className="primary full" style={{marginTop:"10px"}} onClick={() => void runBulkPlan()} disabled={bulkPlanLoading || !workspace?.groups.length || bulkProgress !== null || Boolean(job && ["queued", "running", "paused"].includes(job.status))}>
            {bulkPlanLoading ? "Planning…" : <><WandSparkles size={16} />Plan Video</>}
          </button>
          {Boolean(job && ["queued", "running", "paused"].includes(job.status)) && <p style={{fontSize:"11px",color:"var(--muted)",margin:"6px 0 0",textAlign:"center"}}>Stop the active job to re-plan.</p>}
          <button className="secondary full" style={{marginTop:"8px"}} onClick={() => setBulkOpen(false)}>Cancel</button>
        </div>
      </div>}
      {bulkOverviewOpen && bulkPlan && <div className="modal-backdrop" role="presentation" onMouseDown={() => { setBulkOverviewOpen(false); setBulkPlan(null); }}>
        <div className="modal bulk-overview-modal" onMouseDown={(e) => e.stopPropagation()}>
          <h2>Visual Plan — {bulkPlan.summary.totalStills} Stills</h2>
          <p className="overview-summary">{bulkPlan.summary.shortOverview}</p>
          <div className="visual-type-counts">
            {Object.entries(bulkPlan.summary.visualTypeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => (
              <span key={type} className="type-badge"><strong>{count}</strong>{type}</span>
            ))}
          </div>
          <div className="bulk-overview-table">
            <div className="overview-table-head">
              <span>#</span><span>Timestamp</span><span>Narration</span><span>Visual Type</span><span>Scene Description</span>
            </div>
            {bulkPlan.stills.map((still) => (
              <div key={still.visualPlanRowId} className="overview-table-row">
                <span>{still.ordinal}</span>
                <span>{formatTimeShort(still.timestampStart)}–{formatTimeShort(still.timestampEnd)}</span>
                <span title={still.narrationPreview} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{still.narrationPreview}</span>
                <span>{still.visualType}</span>
                <span title={still.userPrompt}>{still.userPrompt.slice(0, 70)}{still.userPrompt.length > 70 ? "…" : ""}</span>
              </div>
            ))}
          </div>
          <div className="overview-actions">
            <button className="primary" onClick={() => void approveBulkPlan()} disabled={loading}>Apply & Generate All</button>
            <button className="secondary" onClick={() => { setBulkOverviewOpen(false); setBulkOpen(true); }}>Back</button>
            <button className="secondary" onClick={() => { setBulkOverviewOpen(false); setBulkPlan(null); }}>Cancel</button>
          </div>
        </div>
      </div>}
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
  // Proportional UI scaling: keep the exact same layout/proportions on every screen,
  // simply scaled down on smaller displays. Uses the NATIVE webview zoom (true
  // browser zoom) rather than CSS `zoom` — CSS zoom on <body> desyncs click
  // hit-testing in WebView2 (page renders but clicks miss their targets). The
  // scale is derived from the physical window width / DPI, which is independent
  // of the webview zoom, so it never feeds back on itself.
  useEffect(() => {
    const REFERENCE_WIDTH = 1768; // 220px sidebar + 1480px content + padding = native full size
    const win = getCurrentWindow();
    const webview = getCurrentWebview();
    let disposed = false;
    const applyScale = async () => {
      try {
        const size = await win.innerSize();      // physical pixels (zoom-independent)
        const dpr = await win.scaleFactor();     // Windows DPI factor (e.g. 1.5)
        const cssWidth = size.width / dpr;       // CSS px at zoom 1.0
        const scale = Math.min(1, cssWidth / REFERENCE_WIDTH);
        if (!disposed) await webview.setZoom(scale);
      } catch {
        /* setZoom unavailable (e.g. non-Tauri) — leave at native size */
      }
    };
    void applyScale();
    const unlisten = win.onResized(() => void applyScale());
    return () => {
      disposed = true;
      void unlisten.then((off) => off());
    };
  }, []);
  useEffect(() => log("info", "application_started", { release: "1.2.10" }), []);
  useEffect(() => { void projectsClient.startupDiagnostic().then(setStartupNotice); }, []);
  useEffect(() => {
    void projectsClient.getAppSetting("theme").then((saved) => {
      if (saved === "dark" || saved === "light") {
        const { theme: current, toggleTheme } = useAppStore.getState();
        if (saved !== current) toggleTheme();
      }
    });
  }, []);
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
    <div className={stage === "home" ? "app-shell app-shell-home" : "app-shell"}>
      <TitleBar />
      {stage !== "home" && <Sidebar />}
      <main><Header />{startupNotice && <div className="startup-notice">{startupNotice}<button onClick={() => setStartupNotice(null)}>Dismiss</button></div>}{stage === "home" && <HomeView />}{["inputs", "visual-plan"].includes(stage) && <ProductionView />}{stage === "images" && <ImagesView />}{stage === "timeline" && <TimelineView />}</main>
      <ToastDisplay />
    </div>
  );
}

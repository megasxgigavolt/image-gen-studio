import {
  AlertTriangle,
  CheckCircle2,
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
  Scissors,
  Users,
  MapPin,
  Tag,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
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
import { Fragment, type ChangeEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type AppStage, lastSelectedStill, lastVisualPlanScrollTop, lastVisualsStillListScrollTop, useAppStore } from "./store/app-store";
import { log } from "./infrastructure/logger";
import { resolveAssetUrl, resolveRenderUrl } from "./infrastructure/media-cache";
import { formatTimeShort } from "./domain/timecode";
import { sectionGroupsByScene } from "./domain/visual-plan";
import { isTypingTarget } from "./timeline/shortcut-resolver";
import { sceneSelectionState, toggleScene } from "./domain/bulk-selection";
import {
  projectsClient,
  isTauri,
  type ChannelRecord,
  type ResumeRecord,
  type VideoRecord,
  type VisualPlanRecord,
  type ImageWorkspaceRecord,
  type ImageWorkspaceGroupRecord,
  type ImageJobRecord,
  type SingleStillGenerationRecord,
  type BulkGenerationRequestRecord,
  type ImageRenderRecord,
  type PlanSceneRecord,
  type BulkSceneSettingsRecord,
  type BulkGlobalVisualSettingsRecord,
  type BulkStillSettingsRecord,
  type BulkVisualDialsRecord,
  type RosterCharacterRecord,
  type RosterLocationRecord,
  type SceneCastAssignmentRecord,
  type StyleAspectRecord,
  emptyBulkVisualDials,
  emptyBulkGlobalVisualSettings,
} from "./infrastructure/projects-client";
import { TimelineView } from "./TimelineView";
import { AnimateView } from "./AnimateView";
import { ExportMiniBadge } from "./ExportMiniBadge";
import { PreferencesModal } from "./PreferencesModal";

const navItems: { stage: AppStage; label: string; icon: typeof Home }[] = [
  { stage: "inputs", label: "Inputs", icon: Upload },
  { stage: "images", label: "Visuals", icon: Image },
  { stage: "animate", label: "Animate", icon: Film },
  { stage: "timeline", label: "Editor", icon: Scissors },
];
const MAX_CACHE_SIZE = 20;
const imageWorkspaceCache = new Map<string, ImageWorkspaceRecord>();
/** videoId → the user's last manual still-selection edits in the Bulk
 * Generation panel — so reopening the panel without generating restores
 * what was checked instead of always recomputing the default "needs
 * generation" set. Cleared once a request is actually enqueued for that
 * video, since the next open should start from a fresh default again. */
const lastBulkSelection = new Map<string, Set<string>>();

function setCached(key: string, value: ImageWorkspaceRecord) {
  if (imageWorkspaceCache.size >= MAX_CACHE_SIZE) {
    const oldest = imageWorkspaceCache.keys().next().value;
    if (oldest !== undefined) imageWorkspaceCache.delete(oldest);
  }
  imageWorkspaceCache.set(key, value);
}

/** videoId → the visual plan's STILL STRUCTURE (groups) has changed since
 * Images last explicitly synced to it via "Continue to images →". By
 * design, plain navigation to the Visuals tab (the left sidebar's button)
 * does NOT clear this or fetch a fresh workspace while it's set - Images
 * keeps showing whatever structure it last committed to, exactly as it
 * was, until the user explicitly re-confirms the new plan. Without this,
 * a still recalculation/edit made in the Visual Plan tab would otherwise
 * flash through a mismatched cache-then-fresh-fetch swap the instant you
 * next opened Visuals from the sidebar, showing a wrong or stale image
 * for a moment before correcting itself. */
const imagesPlanDirty = new Set<string>();

function markPlanDirtyForImages(videoId: string | null) {
  if (videoId) imagesPlanDirty.add(videoId);
}

/** Whichever render should be treated as "the" selected version for a
 * still — the one explicitly locked via `isFinal` (set by browsing to a
 * version, see selectRender) if there is one, otherwise the newest.
 * `imageRenders` is already newest-first (version DESC), so `[0]` is the
 * correct "no lock yet" fallback. Every place that derives selectedRenderId
 * from a group (initial load, restore-on-remount, clicking a still) must
 * go through this — using imageRenders[0] directly silently discards
 * whatever version the user had locked in and reverts to the newest one. */
function finalOrNewestRender(group: { imageRenders: ImageRenderRecord[] } | null | undefined): ImageRenderRecord | undefined {
  if (!group) return undefined;
  return group.imageRenders.find((render) => render.isFinal) ?? group.imageRenders[0];
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
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
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
    // confirm-backdrop (see styles.css) always stacks above a plain
    // modal-backdrop — a ConfirmDialog is frequently opened WHILE another
    // modal is still showing behind it (e.g. "Add to queue?" over the Bulk
    // Generation panel), and with both sharing the same z-index, whichever
    // one is later in the DOM would otherwise win regardless of which is
    // actually meant to be on top.
    <div className="modal-backdrop confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <div ref={dialogRef} className="modal confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p style={{ color: "var(--muted)", fontSize: "13px", lineHeight: 1.55, marginTop: "8px" }}>{message}</p>
        <div className="footer-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className={danger ? "primary danger" : "primary"} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Best-effort, invisible-until-relevant background update check: looks once
// on launch for a newer signed release published to GitHub Releases (see
// tauri.conf.json's plugins.updater.endpoints and releases/publish-release.ps1).
// Never blocks or interrupts the user — a failed/absent check just means no
// banner ever appears, same soft-fail convention used elsewhere in this app.
function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [status, setStatus] = useState<"idle" | "downloading" | "restarting">("idle");
  const [progress, setProgress] = useState<{ downloaded: number; total: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    checkForUpdate()
      .then((found) => { if (found?.available) setUpdate(found); })
      .catch((error) => log("warn", "update_check_failed", { error: String(error) }));
  }, []);
  if (!update || dismissed) return null;
  const installUpdate = () => {
    setStatus("downloading");
    let total = 0;
    let downloaded = 0;
    update
      .downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress({ downloaded, total });
        }
      })
      .then(() => { setStatus("restarting"); return relaunch(); })
      .catch((error) => {
        log("warn", "update_install_failed", { error: String(error) });
        setStatus("idle");
        setDismissed(true);
      });
  };
  const percent = progress && progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : null;
  return (
    <div className="update-notice">
      {status === "idle" && (
        <>
          <span><Download size={15} /> Update available: v{update.version}</span>
          <div className="update-notice-actions">
            <button type="button" onClick={installUpdate}>Update &amp; Restart</button>
            <button type="button" className="ghost" onClick={() => setDismissed(true)}>Later</button>
          </div>
        </>
      )}
      {status === "downloading" && (
        <span><LoaderCircle size={15} className="spin" /> Downloading update{percent !== null ? ` — ${percent}%` : "…"}</span>
      )}
      {status === "restarting" && <span><LoaderCircle size={15} className="spin" /> Restarting…</span>}
    </div>
  );
}

function ToastDisplay() {
  const { toast, dismissToast } = useAppStore();
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, toast.durationMs);
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
  const [preferencesOpen, setPreferencesOpen] = useState(false);

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

  // Position of the current stage within the pipeline — items before it are
  // "completed" (dim dot), the matching one is "active" (bright dot), items
  // after it haven't been visited yet this session (dark dot).
  const currentIndex = navItems.findIndex(({ stage: itemStage }) =>
    itemStage === "inputs" ? ["inputs", "visual-plan"].includes(stage) : stage === itemStage,
  );

  return (
    <aside className="sidebar">
      <button className="brand" onClick={handleBrandClick} title="Auto Gen Studio">
        <span className="brand-mark"><span /></span>
      </button>
      <nav>
        {navItems.map(({ stage: itemStage, label, icon: Icon }, index) => {
          const isActive = itemStage === "inputs"
            ? ["inputs", "visual-plan"].includes(stage)
            : stage === itemStage;
          const isDisabled = !activeVideoId;
          const dotState = isActive ? "active" : currentIndex >= 0 && index < currentIndex ? "completed" : "pending";
          return (
            <button
              className={isActive ? "nav-item active" : "nav-item"}
              key={itemStage}
              onClick={() => setStage(itemStage === "inputs" ? lastProductionStage : itemStage)}
              disabled={isDisabled}
              title={isDisabled ? "Open a video first" : label}
              aria-current={isActive ? "page" : undefined}
            >
              <span className={`nav-item-dot ${dotState}`} aria-hidden="true" />
              <Icon size={18} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <button className="nav-item settings" onClick={() => setPreferencesOpen(true)}>
        <Settings size={18} /><span>Preferences</span>
      </button>
      {appVersion && <small className="app-version-line">v{appVersion}</small>}
      {preferencesOpen && createPortal(<PreferencesModal onClose={() => setPreferencesOpen(false)} />, document.body)}
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
        {stage !== "timeline" && <span className="saved">Saved locally</span>}
        <button className="icon-button" onClick={handleToggleTheme} aria-label="Toggle theme">
          {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
        </button>
      </div>
    </header>
  );
}

function RowMenu({ anchorRect, onRename, onShare, onDelete, onClose }: {
  anchorRect: DOMRect;
  onRename: () => void;
  onShare?: () => void;
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
      {onShare && <button role="menuitem" onClick={() => { onShare(); onClose(); }}>Share project…</button>}
      <button role="menuitem" className="danger-action" onClick={() => { onDelete(); onClose(); }}>Delete</button>
    </div>,
    document.body,
  );
}

function stageLabel(stage: AppStage): string {
  if (stage === "timeline") return "Editor";
  if (stage === "visual-plan") return "Plan";
  if (stage === "images") return "Visuals";
  if (stage === "animate") return "Animate";
  if (stage === "inputs") return "Inputs";
  return stage;
}

const PIPELINE_STAGES: { stage: AppStage; label: string }[] = [
  { stage: "inputs", label: "Inputs" },
  { stage: "visual-plan", label: "Plan" },
  { stage: "images", label: "Visuals" },
  { stage: "animate", label: "Animate" },
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
  const { setStage, setActiveProject, activeChannelId, addToast } = useAppStore();
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
  const [channelAbout, setChannelAbout] = useState("");
  // Tracks whether the name field has been interacted with, so the "Name
  // cannot be empty" error only appears after the user actually tried
  // something — never on initial modal render.
  const [nameTouched, setNameTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [renamingChannelId, setRenamingChannelId] = useState<string | null>(null);
  const [renamingVideoId, setRenamingVideoId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [videoPreviewUrls, setVideoPreviewUrls] = useState<Record<string, string>>({});
  const [channelMenu, setChannelMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [videoMenu, setVideoMenu] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [importingProject, setImportingProject] = useState(false);
  const [sharingVideoId, setSharingVideoId] = useState<string | null>(null);
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
    if (!name.trim()) {
      setNameTouched(true);
      return;
    }
    try {
      if (dialog === "channel") {
        const channel = await projectsClient.createChannel(name.trim(), channelAbout.trim() || undefined);
        setSelectedChannelId(channel.id);
      } else if (dialog === "video" && selectedChannelId) {
        await projectsClient.createVideo(selectedChannelId, name.trim());
      }
      setDialog(null);
      setName("");
      setChannelAbout("");
      setNameTouched(false);
      await loadWorkspace();
    } catch (caught) {
      setError(String(caught));
    }
  }

  // Full-fidelity project bundle (.agsproj) — round-trips the entire
  // project: visual plan, every render/animation version, the Editor
  // timeline, media library, and overlay tracks. Meant for sending a whole
  // project to someone else and having it open looking exactly as it did
  // here.
  async function shareProject(video: VideoRecord) {
    setError(null);
    setSharingVideoId(video.id);
    try {
      const result = await projectsClient.exportProjectBundle(video.id);
      if (!result) return; // user cancelled the save dialog
      addToast(`Saved project bundle: ${result.path}`, "success");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSharingVideoId(null);
    }
  }

  // A project bundle is just a video — it always imports into the
  // currently selected channel (same as "+ New video"), never a channel of
  // its own.
  async function importProjectBundle() {
    if (!selectedChannelId) return;
    setError(null);
    setImportingProject(true);
    try {
      const video = await projectsClient.importProjectBundle(selectedChannelId);
      if (!video) return; // user cancelled the file picker
      await loadWorkspace();
      const channel = channels.find((candidate) => candidate.id === video.channelId);
      if (channel) {
        setActiveProject(channel.id, channel.name, video.id, video.title);
        setStage(video.stage);
      }
      addToast(`Imported "${video.title}"`, "success");
    } catch (caught) {
      setError(String(caught));
    } finally {
      setImportingProject(false);
    }
  }

  async function openVideo(video: VideoRecord) {
    const channel = channels.find((candidate) => candidate.id === video.channelId);
    if (!channel) return;
    // A video at 100% progress (e.g. an "Import video" bundle) is done — its
    // only stage with real content is the Editor. `stage` on the record is
    // really "last tab visited," not "furthest real progress": every stage
    // switch persists as the new resume point (see the [stage] effect
    // below), so idly checking an intentionally-empty Script/Visuals tab on
    // a finished project silently drags the saved stage backwards there,
    // and the next time the card is clicked it reopens on that empty tab —
    // looks exactly like "the import is broken" even though the data is
    // fine. Finished projects always reopen on Editor regardless of
    // whichever tab was looked at last.
    const effectiveStage = video.progress === 100 && video.stage !== "timeline" ? "timeline" : video.stage;
    // Navigate first; persisting resume/snapshot is best-effort and must never
    // block or cancel navigation if a database write happens to fail.
    setActiveProject(channel.id, channel.name, video.id, video.title);
    setStage(effectiveStage);
    try {
      await projectsClient.setResume(channel.id, video.id, effectiveStage);
      await projectsClient.createSnapshot(video.id, {
        reason: "video-opened",
        stage: effectiveStage,
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
        {error && <div className="inline-error dismissible"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
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
        <button className="nav-item settings" onClick={() => setPreferencesOpen(true)}>
          <Settings size={18} /><span>Preferences</span>
        </button>
        {appVersion && <small className="app-version-line">v{appVersion}</small>}
        {preferencesOpen && <PreferencesModal onClose={() => setPreferencesOpen(false)} />}
      </aside>
      <section className="launcher-videos">
        {resume && showResumeBanner && resume.channelId === selectedChannelId && (
          <button className="resume-band" onClick={() => void resumeVideo()}>
            <div><span>Continue</span><h2>{resumeVideoRecord?.title ?? "Resume last video"}</h2><p>{selectedChannel?.name} · {stageLabel(resume.stage)}</p></div>
            <strong>→</strong>
          </button>
        )}
        <div className="section-heading"><h2>Videos</h2><div><button disabled={!selectedChannelId} onClick={() => setDialog("video")}><Plus size={14} /> New video</button><button className="secondary" disabled={!selectedChannelId || importingProject} onClick={() => void importProjectBundle()} title="Import a project someone shared with you (.agsproj) into this channel">{importingProject ? <><LoaderCircle className="spin" size={14} />Importing…</> : <><Download size={14} /> Import project</>}</button></div></div>
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
                  disabled={sharingVideoId === video.id}
                  onClick={(e) => setVideoMenu({ id: video.id, rect: e.currentTarget.getBoundingClientRect() })}
                >{sharingVideoId === video.id ? <LoaderCircle className="spin" size={16} /> : <MoreHorizontal size={16} />}</button>
                {videoMenu?.id === video.id && (
                  <RowMenu
                    anchorRect={videoMenu.rect}
                    onRename={() => void startRenameVideo(video)}
                    onShare={() => void shareProject(video)}
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
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { setDialog(null); setName(""); setChannelAbout(""); setNameTouched(false); }}>
          <form className="modal" onSubmit={(event) => void submitCreate(event)} onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">{dialog === "channel" ? "New workspace" : "New production"}</p>
            <h2>{dialog === "channel" ? "Create channel" : "Create video"}</h2>
            <label>{dialog === "channel" ? "Channel name" : "Video title"}<input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => { if (!name.trim()) setNameTouched(true); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setDialog(null); setName(""); setChannelAbout(""); setNameTouched(false); } }}
            /></label>
            {nameTouched && !name.trim() && <p style={{ fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>Name cannot be empty.</p>}
            {dialog === "channel" && (
              <label style={{ marginTop: "10px" }}>
                <span style={{ display: "flex", justifyContent: "space-between" }}>About this channel<small style={{ color: "var(--muted)", fontWeight: 500 }}>Optional</small></span>
                <small className="modal-hint">Used by the AI when generating plans, prompts, and suggestions.</small>
                <textarea
                  rows={3}
                  value={channelAbout}
                  onChange={(event) => setChannelAbout(event.target.value)}
                  placeholder="Describe your subject, angle, and audience."
                />
              </label>
            )}
            <div className="footer-actions"><button type="button" className="secondary" onClick={() => { setDialog(null); setName(""); setChannelAbout(""); setNameTouched(false); }}>Cancel</button><button className="primary" type="submit" disabled={!name.trim()}>Create</button></div>
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
  const [, setStatus] = useState("Loading source material…");
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
  // Pacing is part of this signature so that changing it after a plan
  // already exists flips "View visual plan →" back to "Generate visual
  // plan →" — the same existing mechanism that already prompts a
  // regeneration when the script or audio changes — rather than silently
  // leaving the stale plan in place with no indication pacing didn't apply.
  const inputSignature = useMemo(() => JSON.stringify({
    script,
    audioId: audio?.id ?? null,
    pacingPreset,
    pacingMin,
    pacingMax,
  }), [audio?.id, script, pacingPreset, pacingMin, pacingMax]);

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
      // Must mirror inputSignature's shape exactly — this is the baseline
      // it's compared against, computed here from the just-loaded inputs
      // rather than from component state (which hasn't re-rendered with
      // the setPacing* calls above yet at this point in the callback).
      const signature = JSON.stringify({
        script: inputs.scriptText,
        audioId: inputs.audio?.id ?? null,
        pacingPreset: inputs.pacingPreset,
        pacingMin: inputs.pacingMinSeconds,
        pacingMax: inputs.pacingMaxSeconds,
      });
      // planMatchesCurrentInputs is persisted server-side (what was
      // actually used the last time this plan was generated), unlike this
      // reconstructed `signature` which only reflects current video_inputs
      // and can't tell "pacing changed since generation" on its own after
      // a fresh reload — see MIGRATION_033's doc comment. false means a
      // mismatch: force the comparison below to fail so the button shows
      // "Generate" instead of "View". null (no snapshot recorded, e.g. a
      // legacy plan) falls back to assuming it matches, same as before.
      void projectsClient.getVisualPlan(activeVideoId)
        .then(() => {
          setHasPlan(true);
          setGeneratedInputSignature(inputs.planMatchesCurrentInputs === false ? null : signature);
        })
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
      // A (re)generated plan's still structure must not reach Images until
      // the user explicitly confirms it via "Continue to images →" - see
      // imagesPlanDirty. Harmless no-op for a video's very first plan,
      // since Images has no cache yet to protect at that point anyway.
      markPlanDirtyForImages(activeVideoId);
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
      <div className="page-heading">
        <div><h1>Inputs</h1><p>Add narration and references that will guide the visual plan.</p></div>
        {ready ? (
          <span className="readiness-badge ready"><CheckCircle2 size={13} />Ready for planning</span>
        ) : (
          <span className="readiness-badge">
            <AlertTriangle size={13} />
            {!script.trim() && !audio ? "Script and voiceover required" : !script.trim() ? "Script required" : "Voiceover required"}
          </span>
        )}
      </div>
      {!activeVideoId && <div className="inline-error">Open or create a video before adding source material.</div>}
      {error && <div className="inline-error dismissible"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
      <div className="inputs-grid">
        <article className="panel script-panel">
          <div className="panel-heading"><div><h2>Script</h2><p>Paste narration or import a UTF-8 text file.</p></div><button className="secondary" onClick={() => void importScript()}><Upload size={15} />Import</button></div>
          <textarea value={script} onChange={(event) => { setScript(event.target.value); setStatus("Saving…"); }} placeholder="Paste the final narration script here…" />
          <footer><span>{wordCount.toLocaleString()} words</span><span>Approx. {Math.ceil(wordCount / 150)} min</span></footer>
        </article>
        <div className="panel-stack">
          <article className="panel"><div className="panel-heading"><div><h2>Narration audio</h2><p>Used for word-level timing.</p></div>{!audio && <button className="secondary" onClick={() => void importAsset("audio")}><Upload size={15} />Import</button>}</div>{audio ? <div className="file-row"><span>♪</span><div><strong>{audio.originalName}</strong><small>{(audio.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></div><button className="icon-button" onClick={() => void removeAsset(audio.id)}><X size={15} /></button></div> : <div className="asset-empty">WAV, MP3, M4A, AAC, or FLAC</div>}</article>
          <article className="panel pacing-panel">
            <div className="pacing-heading">
              <div><h2>Scene pacing</h2><p>Preferred duration range per still</p></div>
              <strong>{pacingPreset === "per-sentence" ? "1 sentence" : `${pacingMin}–${pacingMax} sec`}</strong>
            </div>
            <div className="pacing-options">
              {([["calm", "Calm", "10–16s per still"], ["balanced", "Balanced", "6–10s per still"], ["fast", "Fast", "3–6s per still"], ["per-sentence", "Every sentence", "One still per sentence"]] as const).map(([value, label, detail]) => (
                <button key={value} type="button" className={pacingPreset === value ? "pacing-tile active" : "pacing-tile"} onClick={() => void choosePacing(value)}>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </button>
              ))}
              <div
                className={pacingPreset === "custom" ? "pacing-tile custom active expanded" : "pacing-tile custom"}
                role="button"
                tabIndex={0}
                onClick={() => { if (pacingPreset !== "custom") void choosePacing("custom"); }}
                onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && pacingPreset !== "custom") { event.preventDefault(); void choosePacing("custom"); } }}
              >
                <strong>Custom</strong>
                {pacingPreset === "custom" ? (
                  <div className="custom-pacing-inline" onClick={(event) => event.stopPropagation()}>
                    <label>Minimum<input type="number" min="2" max="30" value={pacingMin} onChange={(event) => setPacingMin(Number(event.target.value))} onBlur={(event) => void choosePacing("custom", Number(event.target.value), pacingMax)} /></label>
                    <label>Maximum<input type="number" min="2" max="30" value={pacingMax} onChange={(event) => setPacingMax(Number(event.target.value))} onBlur={(event) => void choosePacing("custom", pacingMin, Number(event.target.value))} /></label>
                  </div>
                ) : <small>Choose your own range</small>}
              </div>
            </div>
            {pacingPreset === "per-sentence" && <p style={{ fontSize: "12px", color: "var(--muted)", margin: "8px 0 0" }}>Every sentence becomes its own still — no AI grouping, fastest to generate.</p>}
          </article>
        </div>
      </div>
      <div className="footer-actions">{hasPlan && inputSignature === generatedInputSignature ? <button className="primary" onClick={() => setStage("visual-plan")}>View visual plan →</button> : <button className="primary" disabled={!ready || !activeVideoId || generating} onClick={() => void generatePlan()}>{generating ? <><LoaderCircle className="spin" size={16} />Generating…</> : "Generate visual plan →"}</button>}</div>
    </section>
  );
}

function VisualPlanView() {
  const { activeVideoId, setStage } = useAppStore();
  const [plan, setPlan] = useState<VisualPlanRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedSentenceId, setDraggedSentenceId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Read (not state, so it doesn't re-render on every key press) at drop
  // time in finishDrag — dnd-kit's DragEndEvent doesn't carry the drop
  // moment's modifier-key state, only whichever event originally armed the
  // drag. A plain drop at a scene's own edge starts a new scene there by
  // default; holding Shift explicitly keeps the new still in the current
  // scene instead — see createGroup's keepInCurrentScene parameter.
  const shiftHeldRef = useRef(false);
  useEffect(() => {
    const onKeyChange = (event: KeyboardEvent) => { if (event.key === "Shift") shiftHeldRef.current = event.type === "keydown"; };
    window.addEventListener("keydown", onKeyChange);
    window.addEventListener("keyup", onKeyChange);
    return () => {
      window.removeEventListener("keydown", onKeyChange);
      window.removeEventListener("keyup", onKeyChange);
    };
  }, []);
  const [confirmReset, setConfirmReset] = useState(false);
  // Sentences aren't freely editable — this only ever marks WHERE a split
  // would land (a character offset into that one sentence's own text),
  // armed by clicking inside it and confirmed/cancelled explicitly. See
  // DraggableSentence's split-armed render branch.
  const [splitArm, setSplitArm] = useState<{ sentenceId: string; offset: number } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  // In-memory undo/redo — mirrors useTimelineData's undoStackRef/
  // redoStackRef pattern: every mutation pushes the plan as it was right
  // before onto undoStackRef, undo/redo pop between the two stacks and
  // hand a whole snapshot back to restoreVisualPlanSnapshot. Session-only
  // (a fresh stack per video, cleared on reload) and independent of
  // "Reset original", which always targets the fixed generation-time
  // snapshot rather than this edit history.
  const undoStackRef = useRef<VisualPlanRecord[]>([]);
  const redoStackRef = useRef<VisualPlanRecord[]>([]);
  /** `skipHistory` is for mutations that shouldn't clutter undo — a scene
   * expand/collapse toggle (fired on every click), and the undo/redo
   * restore itself (which would otherwise re-push the state it's replacing). */
  async function refresh(promise: Promise<VisualPlanRecord>, options?: { skipHistory?: boolean; skipDirty?: boolean }) {
    const before = plan;
    try {
      const next = await promise;
      setPlan(next);
      if (before && !options?.skipHistory) {
        undoStackRef.current.push(before);
        if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        redoStackRef.current = [];
      }
      // Every structural edit (move/create/merge/split/reset/undo/redo)
      // changes group composition, which Images must NOT pick up until
      // "Continue to images →" - see imagesPlanDirty. Scene expand/collapse
      // (the one skipDirty caller) never touches group ids, so it's exempt.
      if (!options?.skipDirty) markPlanDirtyForImages(activeVideoId);
    } catch (caught) {
      setError(String(caught));
      throw caught;
    }
  }
  async function undo() {
    if (!activeVideoId || !plan || !undoStackRef.current.length) return;
    const previous = undoStackRef.current.pop()!;
    redoStackRef.current.push(plan);
    if (redoStackRef.current.length > 50) redoStackRef.current.shift();
    await refresh(projectsClient.restoreVisualPlanSnapshot(activeVideoId, previous), { skipHistory: true });
  }
  async function redo() {
    if (!activeVideoId || !plan || !redoStackRef.current.length) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(plan);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    await refresh(projectsClient.restoreVisualPlanSnapshot(activeVideoId, next), { skipHistory: true });
  }
  useEffect(() => {
    if (!activeVideoId) return;
    undoStackRef.current = [];
    redoStackRef.current = [];
    void projectsClient.getVisualPlan(activeVideoId).then(setPlan).catch((caught) => setError(String(caught)));
  }, [activeVideoId]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchRefs = useRef<Map<string, HTMLElement>>(new Map());
  const planScrollRef = useRef<HTMLDivElement>(null);
  // Restores this video's plan-list scroll position once, the next time
  // this view mounts for it — the stage router fully unmounts VisualPlanView
  // on every stage switch, so nothing here survives on its own otherwise.
  const restoredScrollForVideoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeVideoId || !plan || restoredScrollForVideoRef.current === activeVideoId) return;
    restoredScrollForVideoRef.current = activeVideoId;
    const remembered = lastVisualPlanScrollTop.get(activeVideoId);
    if (remembered !== undefined && planScrollRef.current) planScrollRef.current.scrollTop = remembered;
  }, [activeVideoId, plan]);

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
    if (searchMatches.length === 0 || !plan) return;
    const active = searchMatches[Math.min(matchIndex, searchMatches.length - 1)];
    // A match inside a collapsed scene isn't in the DOM yet — expand it and
    // let the `plan` update (scene.expanded flips) re-run this effect, at
    // which point the sentence's ref is registered and this scrolls to it.
    const scene = plan.scenes.find((item) => item.sentenceIds.includes(active.sentenceId));
    if (scene && !scene.expanded) {
      void setSceneExpanded(scene.id, true);
      return;
    }
    matchRefs.current.get(active.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchIndex, searchMatches, plan]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        return;
      }
      // Undo/redo — Ctrl/Cmd+Z, Shift held = redo. Guarded so it never
      // hijacks a text input's own native undo (e.g. the search box).
      if (!isTypingTarget(document.activeElement) && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) void redo(); else void undo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // undo/redo are intentionally omitted — they're plain functions
    // redefined every render, so depending on activeVideoId/plan (what
    // they actually close over) already re-subscribes with fresh ones
    // after every mutation, same pattern as useTimelineData's undo/redo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, activeVideoId, plan]);

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
    try { await refresh(projectsClient.movePlanSentence(activeVideoId, sentenceId, targetGroupId)); }
    catch { /* refresh already recorded the error */ }
  }

  async function resetPlan() {
    if (!activeVideoId) return;
    await refresh(projectsClient.resetVisualPlan(activeVideoId));
  }

  // The only path that's allowed to sync Images to a plan that changed
  // here (see imagesPlanDirty) - prefetches the freshly-recalculated
  // workspace and primes the cache with it BEFORE switching stages, so
  // ImagesView's own cache-first mount render already shows the correct,
  // final state instead of the old cache flashing through first.
  async function continueToImages() {
    if (activeVideoId) {
      try {
        setCached(activeVideoId, await projectsClient.getImageWorkspace(activeVideoId));
      } catch {
        // Best-effort prefetch only - if this fails, ImagesView's own
        // mount-time fetch will surface the error the normal way.
      }
      imagesPlanDirty.delete(activeVideoId);
    }
    setStage("images");
  }

  async function createGroup(sentenceId: string, insertIndex: number, keepInCurrentScene: boolean) {
    if (!activeVideoId) return;
    try { await refresh(projectsClient.createPlanGroup(activeVideoId, sentenceId, insertIndex, keepInCurrentScene)); }
    catch { /* refresh already recorded the error */ }
  }

  async function mergeSentences(firstSentenceId: string, secondSentenceId: string) {
    if (!activeVideoId) return;
    try { await refresh(projectsClient.mergePlanSentences(activeVideoId, firstSentenceId, secondSentenceId)); }
    catch { /* refresh already recorded the error */ }
  }

  async function setSceneExpanded(sceneId: string, expanded: boolean) {
    if (!activeVideoId) return;
    try { await refresh(projectsClient.setPlanSceneExpanded(activeVideoId, sceneId, expanded), { skipHistory: true, skipDirty: true }); }
    catch { /* refresh already recorded the error */ }
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
      void createGroup(sentenceId, Number(target.replace(/^divider:/, "")), shiftHeldRef.current);
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

  // Double-clicking inside a sentence's text only ever arms a split point —
  // never edits the wording itself. Re-arming (double-clicking elsewhere in
  // the same or a different sentence) just moves the marker; nothing is
  // committed until confirmSplit.
  function armSplit(sentenceId: string, offset: number) {
    setSplitArm({ sentenceId, offset });
  }

  function cancelSplit() {
    setSplitArm(null);
  }

  function confirmSplit() {
    if (!activeVideoId || !splitArm) return;
    const sentence = plan?.sentences.find((s) => s.id === splitArm.sentenceId);
    if (!sentence) { setSplitArm(null); return; }
    const leftText = sentence.text.slice(0, splitArm.offset);
    const rightText = sentence.text.slice(splitArm.offset);
    setSplitArm(null);
    if (!leftText.trim() || !rightText.trim()) return;
    void refresh(projectsClient.splitPlanSentence(activeVideoId, splitArm.sentenceId, leftText, rightText)).catch(() => {
      /* refresh already recorded the error */
    });
  }

  useEffect(() => {
    if (!splitArm) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") cancelSplit();
      else if (event.key === "Enter") confirmSplit();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [splitArm]);

  // Sibling rows in the same flat .plan-list — a scene strip is interleaved
  // before its section's first still, not a wrapper around it, so the
  // existing DndContext/StillDivider drop-target model needs no changes.
  const sections = useMemo(() => (plan ? sectionGroupsByScene(plan.groups, plan.scenes) : []), [plan]);
  // Independent of what's actually rendered (a collapsed scene's stills are
  // skipped below) — divider insertIndex/plan-index always need this
  // group's true position in the full plan.groups array, not its position
  // among currently-visible rows.
  const groupIndexById = useMemo(() => new Map(plan?.groups.map((group, index) => [group.id, index]) ?? []), [plan]);
  // null while nothing is being dragged (every divider renders normally);
  // a Set of the specific insertIndex values valid for the sentence
  // currently being dragged once a drag starts — see StillDivider below.
  const validDividerIndexes = useMemo(
    () => (plan && draggedSentenceId ? new Set(validDividerIndexesForSentence(plan, draggedSentenceId)) : null),
    [plan, draggedSentenceId],
  );

  return (
    <section className="view">
      <div className="page-heading">
        <div><h1>Visual plan</h1><p>Drag a sentence onto another to merge them, or into a still to regroup it. Click inside a sentence to mark where it should split, then confirm. Chronological order remains enforced.</p></div>
        <div className="heading-actions"><button className="secondary" onClick={() => setStage("inputs")}>← Back</button><button className="secondary" disabled={!plan} onClick={() => setConfirmReset(true)}>Reset original</button><button className="primary" disabled={!plan} onClick={() => void continueToImages()}>Continue to images →</button></div>
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
      {error && <div className="inline-error dismissible"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
      {!plan && !error && <div className="empty-state">Loading visual plan…</div>}
      {confirmReset && <ConfirmDialog title="Reset visual plan?" message="This restores everything to exactly how it was right after generation — groupings, and any sentence edits, splits, or merges. Everything you've changed since then will be lost." confirmLabel="Reset" onConfirm={() => { setConfirmReset(false); void resetPlan(); }} onCancel={() => setConfirmReset(false)} />}
      {plan && <><div className="plan-summary"><strong>{plan.groups.length} stills</strong><span>{formatTimeShort(plan.sentences.at(-1)?.endSeconds ?? 0)} total · Average {((plan.sentences.at(-1)?.endSeconds ?? 0) / plan.groups.length).toFixed(1)} sec · {plan.scenes.length} scene{plan.scenes.length === 1 ? "" : "s"}</span></div>
      <div
        className="plan-scroll"
        ref={planScrollRef}
        onScroll={(event) => { if (activeVideoId) lastVisualPlanScrollTop.set(activeVideoId, event.currentTarget.scrollTop); }}
      ><DndContext
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
        <StillDivider insertIndex={0} active={dropTarget === "divider:0"} eligible={validDividerIndexes ? validDividerIndexes.has(0) : undefined} />
        {sections.map((section, sectionIndex) => {
          const scene = section.scene;
          const collapsed = Boolean(scene && !scene.expanded);
          const sceneMembers = scene
            ? scene.sentenceIds.map((id) => plan.sentences.find((sentence) => sentence.id === id)).filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence)).sort((a, b) => a.ordinal - b.ordinal)
            : [];
          const lastGroupIndexInSection = section.groups.length - 1;
          // Every section boundary is a real scene transition (sectionGroupsByScene
          // already merges consecutive same-scene groups into one section) — so
          // whenever there's a next section at all, this section's trailing
          // divider sits exactly at a scene seam. It's rendered as a SIBLING of
          // (not nested inside) .plan-scene-section below specifically so it
          // isn't buried inside the card's own padding/border, invisible dead
          // space between two cards that a "drop here to create a new scene"
          // drag would otherwise miss entirely.
          const hasSeamAfter = sectionIndex < sections.length - 1;
          return (
            <Fragment key={scene?.id ?? `no-scene-${sectionIndex}`}>
              <div className="plan-scene-section">
                {scene && sceneMembers.length > 0 && (
                  <SceneStrip
                    scene={scene}
                    stillCount={section.groups.length}
                    startSeconds={sceneMembers[0].startSeconds}
                    endSeconds={sceneMembers.at(-1)!.endSeconds}
                    onToggle={() => void setSceneExpanded(scene.id, !scene.expanded)}
                  />
                )}
                {!collapsed && section.groups.map((group, groupIndexInSection) => {
                  const index = groupIndexById.get(group.id) ?? 0;
                  const members = group.sentenceIds.map((id) => plan.sentences.find((sentence) => sentence.id === id)).filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence)).sort((a,b) => a.ordinal-b.ordinal);
                  const timing = { startSeconds: members[0].startSeconds, endSeconds: members.at(-1)!.endSeconds, durationSeconds: members.at(-1)!.endSeconds-members[0].startSeconds, members };
                  const isLastInSection = groupIndexInSection === lastGroupIndexInSection;
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
                            splitOffset={splitArm?.sentenceId === sentence.id ? splitArm.offset : null}
                            onArmSplit={(offset) => armSplit(sentence.id, offset)}
                            onConfirmSplit={confirmSplit}
                            onCancelSplit={cancelSplit}
                          />
                        ))}
                      </div>
                    </DroppableStill>
                    {/* The last still's divider moves outside the card (below) — every
                        other divider is a normal same-scene split point and stays here. */}
                    {!isLastInSection && <StillDivider insertIndex={index + 1} active={dropTarget === `divider:${index + 1}`} eligible={validDividerIndexes ? validDividerIndexes.has(index + 1) : undefined} />}
                  </div>;
                })}
              </div>
              {!collapsed && section.groups.length > 0 && (() => {
                const lastIndex = groupIndexById.get(section.groups[lastGroupIndexInSection].id) ?? 0;
                return (
                  <StillDivider
                    insertIndex={lastIndex + 1}
                    active={dropTarget === `divider:${lastIndex + 1}`}
                    sceneSeam={hasSeamAfter}
                    eligible={validDividerIndexes ? validDividerIndexes.has(lastIndex + 1) : undefined}
                  />
                );
              })()}
            </Fragment>
          );
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

/** Walks every text node under `container` in document order, accumulating
 * length, to turn a DOM Range (which points at one specific text node —
 * possibly a `<mark>`'s, when the sentence has an active search highlight —
 * plus a local offset within it) into a single absolute character offset
 * into the sentence's own full text. Generic over however many child nodes
 * the rendered content happens to be split across. */
function absoluteTextOffset(container: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.textContent?.length ?? 0;
    node = walker.nextNode();
  }
  return offset;
}

function DraggableSentence({
  sentence, active, dropActive, searchQuery, activeMatchKey, registerMatchRef,
  splitOffset, onArmSplit, onConfirmSplit, onCancelSplit,
}: {
  sentence: PlanSentenceRecord;
  active: boolean;
  dropActive: boolean;
  searchQuery: string;
  activeMatchKey: string | null;
  registerMatchRef: (key: string, el: HTMLElement | null) => void;
  /** Character offset into THIS sentence's text where a split is currently
   * armed, or `null` if this sentence has no armed split right now. */
  splitOffset: number | null;
  onArmSplit: (offset: number) => void;
  onConfirmSplit: () => void;
  onCancelSplit: () => void;
}) {
  const armed = splitOffset !== null;
  const { attributes, listeners, setNodeRef: setDragRef, transform } = useDraggable({ id: `sentence:${sentence.id}`, disabled: armed });
  // The merge drop target is the WHOLE row (not just a small handle) — a
  // sentence dragged on top of another, anywhere on it, merges the two.
  // "Move into a different still without merging" still works by dropping
  // on that still's own empty space or a StillDivider, both of which sit
  // outside every sentence's own rect, so pointerWithin collision detection
  // (see the DndContext below) resolves unambiguously between the two.
  const { setNodeRef: setMergeDropRef, isOver: isMergeOver } = useDroppable({ id: `sentence:${sentence.id}`, disabled: armed });
  const setRefs = useCallback((el: HTMLDivElement | null) => { setDragRef(el); setMergeDropRef(el); }, [setDragRef, setMergeDropRef]);
  const textRef = useRef<HTMLSpanElement>(null);
  const mergeTargetActive = dropActive || isMergeOver;

  // Double-click only — a plain single pointerup/click must NOT arm a split.
  // This used to be a single onPointerUp handler, which meant the pointerup
  // that ENDS a drag-and-drop (releasing a dragged sentence right on/near
  // its own or another sentence's text, which the new scene-seam drop zone
  // makes easy to do) also armed an unwanted split as a side effect, every
  // time. dblclick only ever fires on a genuine double-click gesture, never
  // as part of a drag release.
  function handleTextDoubleClick(event: ReactMouseEvent<HTMLSpanElement>) {
    if (!textRef.current) return;
    const pointFn = (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
    const range = pointFn?.call(document, event.clientX, event.clientY);
    if (!range) return;
    onArmSplit(absoluteTextOffset(textRef.current, range));
  }

  return <div
    ref={setRefs}
    className={[active && "dragging", mergeTargetActive && "merge-target", armed && "split-armed", "sentence"].filter(Boolean).join(" ")}
    style={{ transform: CSS.Translate.toString(transform), touchAction: "none" }}
    {...(armed ? {} : listeners)}
    {...(armed ? {} : attributes)}
  >
    <b className="merge-handle" title="Drag onto another sentence to merge it with this one"><GripVertical size={18} /></b>
    {armed ? (
      <span className="sentence-split-armed">
        <span ref={textRef} onDoubleClick={handleTextDoubleClick}>{sentence.text.slice(0, splitOffset)}</span>
        <span className="split-caret" aria-hidden="true" />
        <span onDoubleClick={handleTextDoubleClick}>{sentence.text.slice(splitOffset)}</span>
        <span className="split-controls">
          <button type="button" className="split-confirm" title="Split here (Enter)" onClick={onConfirmSplit}><Scissors size={13} /><span>Split</span></button>
          <button type="button" className="split-cancel" title="Cancel (Esc)" onClick={onCancelSplit}><X size={14} /></button>
        </span>
      </span>
    ) : (
      <span ref={textRef} onDoubleClick={handleTextDoubleClick} title="Double-click to mark where this sentence should split">
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

function StillDivider({ insertIndex, active, sceneSeam, eligible }: { insertIndex: number; active: boolean; sceneSeam?: boolean; eligible?: boolean }) {
  // eligible is undefined when no sentence is currently being dragged (a
  // divider is never "ineligible" at rest, only relative to whichever
  // sentence is actively in the air) — see validDividerIndexesForSentence.
  const ineligible = eligible === false;
  const { setNodeRef, isOver } = useDroppable({ id: `divider:${insertIndex}`, disabled: ineligible });
  const classes = ["drop-divider"];
  if (sceneSeam) classes.push("scene-seam");
  if (ineligible) classes.push("ineligible");
  if (!ineligible && (active || isOver)) classes.push("drag-over");
  return (
    <div
      ref={setNodeRef}
      className={classes.join(" ")}
      data-seam-hint={sceneSeam ? "Drop here to start a new scene · hold Shift to add a still to the current scene instead" : undefined}
      title={ineligible ? "Not a valid drop point for this sentence — it can only become a new still at its own chronological boundary" : undefined}
    />
  );
}

/** The collapsed-by-default scene header row — a sibling of the still cards
 * in the same flat .plan-list, not a wrapper around them (see the Visual
 * Scene Segmentor plan). Not itself a drop target: dragging a sentence
 * toward a collapsed scene is a no-op in v1, the user expands it first. */
/** "Scene {ordinal}", plus " · {label}" only when the label actually adds
 * information — the AI-derived label falls back to the literal word "Scene"
 * (no real title available, e.g. per-sentence/fallback-mode plans), which
 * used to render as the redundant "Scene 1 · Scene". */
/** Mirrors create_plan_group's is_first/is_last validation (projects.rs)
 * so the frontend can tell, WHILE a sentence is being dragged, exactly
 * which divider(s) it can legally be dropped on to create a new still —
 * only the one(s) at that sentence's own chronological boundary. A middle
 * sentence of a multi-sentence still has none. Used to visually grey out
 * every other divider during that drag, instead of letting the user drop
 * on an invalid one and get a rejection banner that's easy to miss. */
function validDividerIndexesForSentence(plan: VisualPlanRecord, sentenceId: string): number[] {
  const source = plan.groups.findIndex((group) => group.sentenceIds.includes(sentenceId));
  if (source === -1) return [];
  const ids = plan.groups[source].sentenceIds;
  const isFirst = ids[0] === sentenceId;
  const isLast = ids[ids.length - 1] === sentenceId;
  if (isFirst && isLast) return [source, source + 1];
  if (isFirst) return [source];
  if (isLast) return [source + 1];
  return [];
}

function sceneDisplayTitle(scene: { ordinal: number; label: string }): string {
  const label = scene.label.trim();
  const isGeneric = !label || label.toLowerCase() === "scene" || label.toLowerCase() === `scene ${scene.ordinal}`;
  return isGeneric ? `Scene ${scene.ordinal}` : `Scene ${scene.ordinal} · ${label}`;
}

function SceneStrip({ scene, stillCount, startSeconds, endSeconds, onToggle }: {
  scene: VisualPlanRecord["scenes"][number];
  stillCount: number;
  startSeconds: number;
  endSeconds: number;
  onToggle: () => void;
}) {
  return (
    <div className={scene.expanded ? "plan-scene-strip expanded" : "plan-scene-strip"}>
      <button type="button" className="plan-scene-toggle" onClick={onToggle} aria-expanded={scene.expanded}>
        {scene.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="plan-scene-title">{sceneDisplayTitle(scene)}</span>
        <span className="plan-scene-meta">{stillCount} still{stillCount === 1 ? "" : "s"} · {formatTimeShort(startSeconds)}–{formatTimeShort(endSeconds)}</span>
      </button>
    </div>
  );
}

/** The Images tab left pane's compact scene header row — same underlying
 * expand flag as SceneStrip (both read/write visual_plan_scenes.expanded
 * via setPlanSceneExpanded), full breadth of the filmstrip and minimal
 * length: just a chevron, the scene number, and its still count — no
 * narrative context, the full detail is one click away on the Visual Plan
 * tab. */
function LeftPaneSceneStrip({ scene, stillCount, onToggle }: {
  scene: PlanSceneRecord;
  stillCount: number;
  onToggle: () => void;
}) {
  return (
    <div className={scene.expanded ? "stills-scene-strip expanded" : "stills-scene-strip"}>
      <button type="button" className="stills-scene-toggle" onClick={onToggle} aria-expanded={scene.expanded}>
        {scene.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="stills-scene-title">Scene {scene.ordinal}</span>
        <span className="stills-scene-meta">{stillCount} still{stillCount === 1 ? "" : "s"}</span>
      </button>
    </div>
  );
}

/** One scene's row in the Bulk Generation panel: a tri-state select-all
 * checkbox, the same shared expand/collapse chevron as LeftPaneSceneStrip
 * (scene is null for the legacy "no scene" fallback section — no header,
 * no override affordance, no collapse, just the still grid), an inline
 * "Customize" override mini-form, and — when expanded — a grid of
 * individually selectable still thumbnails reusing the left pane's
 * .still-thumb visual language. */
/** Lets a scene pick which roster character(s)/location it uses — chips
 * (multi-select) for characters, a dropdown (single-select) for location.
 * Ported from the ui/visual-director-mockup branch's SceneCastPicker, now
 * wired to the real backend instead of localStorage. The "AI suggested"
 * badge is purely derived — the assignment is untouched-since-suggested
 * exactly when assignedCharacterIds/assignedLocationId still match
 * aiSuggestedCharacterIds/aiSuggestedLocationId, no separate flag needed
 * (see SceneCastAssignment's doc comment on the Rust side). */
function SceneCastPicker({ characters, locations, assignment, onSave }: {
  characters: RosterCharacterRecord[];
  locations: RosterLocationRecord[];
  assignment: SceneCastAssignmentRecord | null;
  onSave: (characterIds: string[], locationId: string | null) => void;
}) {
  if (!characters.length && !locations.length) {
    return <p className="scene-cast-empty">No characters or locations in the roster yet.</p>;
  }
  const assignedCharacterIds = assignment?.assignedCharacterIds ?? [];
  const assignedLocationId = assignment?.assignedLocationId ?? null;
  const hasAnyAssignment = assignedCharacterIds.length > 0 || assignedLocationId !== null;
  const isUnchangedFromAiSuggestion = hasAnyAssignment
    && JSON.stringify(assignedCharacterIds) === JSON.stringify(assignment?.aiSuggestedCharacterIds ?? [])
    && assignedLocationId === (assignment?.aiSuggestedLocationId ?? null);

  function toggleCharacter(id: string) {
    const next = assignedCharacterIds.includes(id) ? assignedCharacterIds.filter((existing) => existing !== id) : [...assignedCharacterIds, id];
    onSave(next, assignedLocationId);
  }

  return (
    <div className="scene-cast-picker">
      {isUnchangedFromAiSuggestion && <span className="scene-cast-ai-badge"><Sparkles size={11} />AI suggested</span>}
      {characters.length > 0 && (
        <div className="scene-cast-group">
          <span className="scene-cast-label"><Users size={12} />Characters</span>
          <div className="tag-list">
            {characters.map((character) => (
              <button type="button" key={character.id} className={`tag-chip selectable${assignedCharacterIds.includes(character.id) ? " selected" : ""}`} onClick={() => toggleCharacter(character.id)}>
                {character.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {locations.length > 0 && (
        <div className="scene-cast-group">
          <span className="scene-cast-label"><MapPin size={12} />Location</span>
          <select value={assignedLocationId ?? ""} onChange={(event) => onSave(assignedCharacterIds, event.target.value || null)}>
            <option value="">None</option>
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

/** The Bulk Generation queue's "up next" list — a compact popover anchored
 * under the "+N queued" toggle in the merged status bar (see the "preview"
 * pane in ImagesView). Floats above the rest of the pane (absolutely
 * positioned, see .bulk-queue-mini-list in styles.css) rather than pushing
 * the header/preview/prompt panel down, and closes on an outside click or
 * Escape like the app's other popovers/dialogs. Only pending (not-yet-
 * started) requests appear here — an active one is controlled via the
 * status bar's own controls instead. Reorder controls only render at all
 * when there's more than one pending request to reorder — with just one,
 * "up"/"down" would always be simultaneously disabled, which read as
 * permanently greyed-out buttons rather than as "nothing to do yet". */
function BulkQueueMiniList({
  pending, onCancel, onReorder, onClose,
}: {
  pending: BulkGenerationRequestRecord[];
  onCancel: (requestId: string) => void;
  onReorder: (requestId: string, direction: "up" | "down") => void;
  onClose: () => void;
}) {
  useEffect(() => {
    // Checked against the whole toggle-button-plus-popover wrapper, not
    // just this list, so a click on the toggle button itself (which sits
    // outside this <ul>, as its sibling) isn't ALSO treated as an "outside"
    // click — mousedown fires before the button's own onClick, so without
    // this it would close here first and then the toggle's own handler
    // would immediately reopen it.
    function handlePointerDown(event: MouseEvent) {
      if ((event.target as HTMLElement).closest?.(".bulk-queue-popover-anchor")) return;
      onClose();
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);
  return (
    <ul className="bulk-queue-mini-list">
      {pending.map((request, index) => (
        <li key={request.id}>
          <span>{request.totalStills} still{request.totalStills === 1 ? "" : "s"}</span>
          <div className="bulk-queue-row-actions">
            {pending.length > 1 && <button type="button" className="icon-button" aria-label="Move up in queue" disabled={index === 0} onClick={() => onReorder(request.id, "up")}><ChevronUp size={13} /></button>}
            {pending.length > 1 && <button type="button" className="icon-button" aria-label="Move down in queue" disabled={index === pending.length - 1} onClick={() => onReorder(request.id, "down")}><ChevronDown size={13} /></button>}
            <button type="button" className="icon-button" aria-label="Remove from queue" onClick={() => onCancel(request.id)}><X size={13} /></button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SceneBulkRow({
  scene, groups, selection, stillSettings, aspectRatio, renderUrls,
  onToggleScene, onToggleStill, expanded, onToggleExpanded,
  override, overrideOpen, onToggleOverrideOpen, onSaveOverride,
  rosterCharacters, rosterLocations, castAssignment, onSaveCast,
  onOpenVisualDirection, onOpenDiversity,
}: {
  scene: PlanSceneRecord | null;
  groups: (ImageWorkspaceGroupRecord & { sceneId: string | null })[];
  selection: Set<string>;
  // Per-still Visualization Type overrides (see the selection bar's "Set
  // visualization type…" control) — shown as a small badge on the
  // overridden still's thumbnail so it's visible without reopening the
  // dropdown.
  stillSettings: BulkStillSettingsRecord[];
  aspectRatio: string;
  renderUrls: Record<string, string>;
  onToggleScene: () => void;
  onToggleStill: (groupId: string) => void;
  // Local to the Bulk Generation panel (bulkExpandedScenes in ImagesView),
  // deliberately not scene.expanded — see the panel's own note on why its
  // collapse state isn't tied to the Visual Plan / Images-pane toggle.
  expanded: boolean;
  onToggleExpanded?: () => void;
  override: BulkSceneSettingsRecord | null;
  overrideOpen: boolean;
  onToggleOverrideOpen: () => void;
  onSaveOverride: (patch: Partial<Omit<BulkSceneSettingsRecord, "sceneId">>) => void;
  rosterCharacters: RosterCharacterRecord[];
  rosterLocations: RosterLocationRecord[];
  castAssignment: SceneCastAssignmentRecord | null;
  onSaveCast: (characterIds: string[], locationId: string | null) => void;
  // Dials themselves live in their own launcher-button modals now (same
  // pattern as the global modal) — this row just opens them.
  onOpenVisualDirection: () => void;
  onOpenDiversity: () => void;
}) {
  const dials = override?.dials ?? emptyBulkVisualDials();
  const visualDirectionSetCount = [dials.visualInterpretation, dials.visualMetaphor, dials.cinematicIntensity, dials.promptCreativity, dials.mood].filter((value) => value !== null).length;
  const diversitySetCount = [dials.diversityCamera, dials.diversityComposition, dials.diversityShotType, dials.consistencyCharacter, dials.consistencyLocation, dials.consistencyStyle].filter((value) => value !== null).length;
  const groupIds = groups.map((group) => group.group.id);
  const state = sceneSelectionState(groupIds, selection);
  const selectedCount = groupIds.filter((id) => selection.has(id)).length;
  return (
    <div className="bulk-scene-row">
      <div className="bulk-scene-row-header">
        <input
          type="checkbox"
          className="bulk-scene-checkbox"
          checked={state === "all"}
          ref={(el) => { if (el) el.indeterminate = state === "some"; }}
          onChange={onToggleScene}
          aria-label={scene ? `Select all stills in Scene ${scene.ordinal}` : "Select all unassigned stills"}
        />
        {scene ? (
          <button type="button" className="bulk-scene-toggle" onClick={onToggleExpanded} aria-expanded={expanded}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="bulk-scene-title">{sceneDisplayTitle(scene)}</span>
          </button>
        ) : (
          <span className="bulk-scene-title no-scene">Unassigned stills</span>
        )}
        <span className="bulk-scene-meta">{selectedCount}/{groupIds.length} stills</span>
        {scene && (
          <button type="button" className="bulk-scene-override-toggle" onClick={onToggleOverrideOpen} aria-expanded={overrideOpen} aria-label="Customize this scene's bulk settings" title="Customize">
            <Settings size={13} />
          </button>
        )}
      </div>
      {scene && overrideOpen && (
        <div className="bulk-scene-override-form">
          <div className="bulk-modal-group">Style Directive</div>
          <textarea rows={2} placeholder="Inherit global" value={override?.styleDirective ?? ""} onChange={(event) => onSaveOverride({ styleDirective: event.target.value || null })} />
          <div className="bulk-modal-group">Creative Instructions</div>
          <textarea rows={2} placeholder="Inherit global" value={override?.creativeInstruction ?? ""} onChange={(event) => onSaveOverride({ creativeInstruction: event.target.value || null })} />
          <div className="bulk-modal-group">Cast &amp; Locations</div>
          <SceneCastPicker
            characters={rosterCharacters}
            locations={rosterLocations}
            assignment={castAssignment}
            onSave={onSaveCast}
          />
          <div className="bulk-modal-group">Visual Direction</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{visualDirectionSetCount} of 5 customized</span>
            <button type="button" className="secondary" onClick={onOpenVisualDirection}>Manage Visual Direction</button>
          </div>
          <div className="bulk-modal-group">Diversity &amp; Consistency</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{diversitySetCount} of 6 customized</span>
            <button type="button" className="secondary" onClick={onOpenDiversity}>Manage Diversity &amp; Consistency</button>
          </div>
        </div>
      )}
      {expanded && (
        <div className="bulk-still-grid">
          {groups.map((group) => {
            const newestRender = group.imageRenders[0];
            const thumbUrl = newestRender ? renderUrls[newestRender.id] : undefined;
            const isSelected = selection.has(group.group.id);
            const visualizationType = stillSettings.find((item) => item.groupId === group.group.id)?.visualizationType;
            return (
              <button
                type="button"
                key={group.group.id}
                className={`bulk-still-thumb-button${isSelected ? " selected" : ""}`}
                onClick={() => onToggleStill(group.group.id)}
                aria-pressed={isSelected}
                title={`Still ${group.group.ordinal}${isSelected ? " — selected" : ""}${visualizationType ? ` — Visualization: ${visualizationType}` : ""}`}
              >
                <div className={`still-thumb ${aspectRatio === "9:16" ? "portrait" : "landscape"}${thumbUrl ? "" : " empty"}`}>
                  {thumbUrl ? <img src={thumbUrl} alt={`Still ${group.group.ordinal} preview`} /> : <div className="still-thumb-empty"><Image size={16} /></div>}
                  <span className="still-number">{group.group.ordinal}</span>
                  {visualizationType && <span className="still-visualization-badge" aria-hidden="true"><Tag size={10} /></span>}
                </div>
                <span className={`bulk-still-checkbox${isSelected ? " checked" : ""}`} aria-hidden="true">{isSelected && <Check size={12} />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
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
  // Set automatically by Bulk Generation planning (see VISUALIZATION_TYPES) —
  // reflects whichever medium/format the AI chose, or the Global Bulk
  // Settings hard rule constrained it to; editable afterward like any other
  // setting, no "Undefined"/blank state.
  visualizationType: string;
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
  visualizationType: "Photograph",
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

const MOOD_DIAL_OPTIONS = ["Serene Peaceful", "Tense Anxious", "Dramatic Intense", "Warm and Cozy", "Cold Distant", "Mysterious", "Cheerful Upbeat", "Melancholic", "Hopeful", "Playful", "Triumphant"];

// The fixed image-medium taxonomy for Visualization Type control — a second,
// independent axis from the AI's own internal visualType (shot/content
// framing) choice. Owned entirely by the frontend; the backend only ever
// stores/relays whatever strings it's sent.
const VISUALIZATION_TYPES = [
  "Photograph", "Cinematic Scene", "Illustration", "Character Sheet", "Storyboard",
  "Infographic", "Diagram", "Chart / Data Visualization", "Map", "Technical Drawing",
  "3D Render", "Concept Visualization", "Graphic Design", "Icon / Symbol", "UI / Screen",
  "Document", "Collage / Composite", "Abstract Visual", "Pattern / Texture", "Isolated Asset",
];

/** One Visual Director / Diversity & Consistency dial at the GLOBAL level —
 * always has a real value (defaults to 50 the first time it's touched);
 * "Reset to AI" clears it back to null ("AI decides per still"). */
function GlobalDialRow({ label, hint, value, onChange }: { label: string; hint?: string; value: number | null; onChange: (value: number | null) => void }) {
  return (
    <div className="dial-row">
      <div className="dial-row-heading">
        <span>{label}</span>
        <button type="button" className="dial-mode-toggle" onClick={() => onChange(value === null ? 50 : null)}>
          {value === null ? "AI decides" : "Reset to AI"}
        </button>
      </div>
      <div className="dial-slider-row">
        <input type="range" min={0} max={100} value={value ?? 50} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} />
        <span className="dial-value">{value ?? "AI"}</span>
      </div>
      {hint && <small className="dial-hint">{hint}</small>}
    </div>
  );
}

/** Same dial at the SCENE level — null means "inherit whatever the global
 * value resolves to" (shown directly in the toggle label so the user always
 * knows what they're inheriting); a value means this scene overrides it. */
function SceneDialRow({ label, hint, value, onChange, globalValue }: { label: string; hint?: string; value: number | null; onChange: (value: number | null) => void; globalValue: number | null }) {
  const overriding = value !== null;
  return (
    <div className="dial-row">
      <div className="dial-row-heading">
        <span>{label}</span>
        <button type="button" className="dial-mode-toggle" onClick={() => onChange(overriding ? null : (globalValue ?? 50))}>
          {overriding ? "Reset to inherit" : `Inherit (${globalValue == null ? "AI" : globalValue})`}
        </button>
      </div>
      {overriding && (
        <div className="dial-slider-row">
          <input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} />
          <span className="dial-value">{value}</span>
        </div>
      )}
      {hint && <small className="dial-hint">{hint}</small>}
    </div>
  );
}

/** Mood + its AI-hint/user-hold mode, at either level — `globalMood` (only
 * passed at scene level) drives the "Inherit" label the same way
 * SceneDialRow's globalValue does. */
function MoodRow({ mood, moodMode, onChange, globalMood, level }: {
  mood: string | null;
  moodMode: string | null;
  onChange: (mood: string | null, moodMode: string | null) => void;
  globalMood?: string | null;
  level: "global" | "scene";
}) {
  const inheriting = level === "scene" && mood === null;
  return (
    <div className="dial-row">
      <div className="dial-row-heading"><span>Mood</span></div>
      <div className="mood-row-controls">
        <select
          value={mood ?? ""}
          onChange={(event) => onChange(event.target.value || null, event.target.value ? (moodMode ?? "ai") : null)}
        >
          <option value="">{level === "scene" ? `Inherit (${globalMood ?? "AI decides"})` : "AI decides per still"}</option>
          {MOOD_DIAL_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
        {!inheriting && mood && (
          <select value={moodMode ?? "ai"} onChange={(event) => onChange(mood, event.target.value)}>
            <option value="ai">Hint only — AI may still pick a different mood per still</option>
            <option value="user">Hold to this mood unless narration clearly conflicts</option>
          </select>
        )}
      </div>
    </div>
  );
}

/** One removable roster card — name input, reference-image thumbnail or
 * upload button, remove button. Characters and locations use the exact
 * same shape (reuses `.reference-item`'s removable-card visual language,
 * same idea as the mockup branch's VisualBibleModal cards, now wired to
 * the real backend). */
function RosterCard({ name, hasReference, onRename, onImportReference, onRemove }: {
  name: string;
  hasReference: boolean;
  onRename: (name: string) => void;
  onImportReference: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="roster-card">
      <input value={name} onChange={(event) => onRename(event.target.value)} placeholder="Name" />
      {hasReference ? (
        <span className="bulk-scene-reference-set">Reference set</span>
      ) : (
        <button type="button" className="secondary" onClick={onImportReference}><Plus size={12} />Upload reference</button>
      )}
      <button type="button" className="icon-button danger-action" aria-label={`Remove ${name || "entry"}`} onClick={onRemove}><Trash2 size={13} /></button>
    </div>
  );
}

/** The character/location roster's management surface — a dedicated modal
 * (not folded into Global Bulk Settings, which already reuses this
 * decision from the earlier ui/visual-director-mockup branch's
 * VisualBibleModal split). */
function RosterModal({
  characters, locations, onClose, onAddCharacter, onAddLocation,
  onRenameCharacter, onRenameLocation, onRemoveCharacter, onRemoveLocation,
  onImportCharacterReference, onImportLocationReference, onSuggestCast, suggesting,
}: {
  characters: RosterCharacterRecord[];
  locations: RosterLocationRecord[];
  onClose: () => void;
  onAddCharacter: () => void;
  onAddLocation: () => void;
  onRenameCharacter: (id: string, name: string) => void;
  onRenameLocation: (id: string, name: string) => void;
  onRemoveCharacter: (id: string) => void;
  onRemoveLocation: (id: string) => void;
  onImportCharacterReference: (id: string) => void;
  onImportLocationReference: (id: string) => void;
  onSuggestCast: () => void;
  suggesting: boolean;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal roster-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2><Users size={18} />Characters &amp; Locations</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 12px"}}>Each entry's reference image is what generation actually conditions on when a scene uses it — pick which ones apply per scene in the Bulk Generation panel.</p>

        <div className="panel-section-heading" style={{marginTop:"4px"}}><h3><Users size={14} />Characters</h3><small>{characters.length}</small></div>
        <div className="roster-cards">
          {characters.map((character) => (
            <RosterCard
              key={character.id}
              name={character.name}
              hasReference={Boolean(character.referenceAssetId)}
              onRename={(name) => onRenameCharacter(character.id, name)}
              onImportReference={() => onImportCharacterReference(character.id)}
              onRemove={() => onRemoveCharacter(character.id)}
            />
          ))}
          {!characters.length && <p className="scene-cast-empty">No characters yet.</p>}
        </div>
        <button type="button" className="secondary" onClick={onAddCharacter}><Plus size={14} />Add character</button>

        <div className="panel-section-heading" style={{marginTop:"18px"}}><h3><MapPin size={14} />Locations</h3><small>{locations.length}</small></div>
        <div className="roster-cards">
          {locations.map((location) => (
            <RosterCard
              key={location.id}
              name={location.name}
              hasReference={Boolean(location.referenceAssetId)}
              onRename={(name) => onRenameLocation(location.id, name)}
              onImportReference={() => onImportLocationReference(location.id)}
              onRemove={() => onRemoveLocation(location.id)}
            />
          ))}
          {!locations.length && <p className="scene-cast-empty">No locations yet.</p>}
        </div>
        <button type="button" className="secondary" onClick={onAddLocation}><Plus size={14} />Add location</button>

        <button type="button" className="secondary full" style={{marginTop:"18px"}} onClick={onSuggestCast} disabled={suggesting || (!characters.length && !locations.length)}>
          {suggesting ? <><LoaderCircle className="spin" size={14} />Suggesting cast…</> : <><Sparkles size={14} />Suggest cast for every scene</>}
        </button>
        <p style={{fontSize:"11px",color:"var(--muted)",margin:"6px 0 0"}}>Reads each scene's narration and picks which of the above it's likely about — re-run this any time after editing the roster; it won't overwrite a scene you've already corrected by hand.</p>

        <button className="primary full" style={{marginTop:"14px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Visual Direction's dials, moved out of the Global Bulk Settings modal
 * into their own launcher-button modal (same "Manage roster" pattern as
 * the character/location roster) — keeps the main modal from being
 * dominated by sliders. */
function VisualDirectionModal({ dials, onChange, onClose }: {
  dials: BulkVisualDialsRecord;
  onChange: (patch: Partial<BulkVisualDialsRecord>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal dial-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Visual Direction</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 10px"}}>Leave any dial on "AI decides" to skip it — an untouched dial never sends anything to the AI.</p>
        <div className="dial-grid">
          <GlobalDialRow label="Visual Interpretation" hint="Literal ↔ Creative" value={dials.visualInterpretation} onChange={(value) => onChange({ visualInterpretation: value })} />
          <GlobalDialRow label="Visual Metaphor" hint="Literal ↔ Symbolic" value={dials.visualMetaphor} onChange={(value) => onChange({ visualMetaphor: value })} />
          <GlobalDialRow label="Cinematic Intensity" hint="Documentary ↔ Cinematic" value={dials.cinematicIntensity} onChange={(value) => onChange({ cinematicIntensity: value })} />
          <GlobalDialRow label="Prompt Creativity" hint="Strict script ↔ Highly creative" value={dials.promptCreativity} onChange={(value) => onChange({ promptCreativity: value })} />
          <MoodRow level="global" mood={dials.mood} moodMode={dials.moodMode} onChange={(mood, moodMode) => onChange({ mood, moodMode })} />
        </div>
        <button className="primary full" style={{marginTop:"14px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Diversity & Consistency's dials — same launcher-button-modal treatment
 * as VisualDirectionModal, replacing the earlier collapsed-<details>
 * approach. */
function DiversityConsistencyModal({ dials, onChange, onClose }: {
  dials: BulkVisualDialsRecord;
  onChange: (patch: Partial<BulkVisualDialsRecord>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal dial-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Diversity &amp; Consistency</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 10px"}}>How stills should differ from, or match, each other.</p>
        <div className="dial-grid">
          <GlobalDialRow label="Camera Angle Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityCamera} onChange={(value) => onChange({ diversityCamera: value })} />
          <GlobalDialRow label="Composition Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityComposition} onChange={(value) => onChange({ diversityComposition: value })} />
          <GlobalDialRow label="Shot Type Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityShotType} onChange={(value) => onChange({ diversityShotType: value })} />
          <GlobalDialRow label="Character Identity Strictness" hint="Flexible ↔ Strict" value={dials.consistencyCharacter} onChange={(value) => onChange({ consistencyCharacter: value })} />
          <GlobalDialRow label="Location Identity Strictness" hint="Flexible ↔ Strict" value={dials.consistencyLocation} onChange={(value) => onChange({ consistencyLocation: value })} />
          <GlobalDialRow label="Style Strictness" hint="Flexible ↔ Strict" value={dials.consistencyStyle} onChange={(value) => onChange({ consistencyStyle: value })} />
        </div>
        <button className="primary full" style={{marginTop:"14px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Scene-level counterparts to VisualDirectionModal/DiversityConsistencyModal
 * — same launcher-button-modal pattern, one level down: SceneDialRow's
 * "Inherit (X)" instead of GlobalDialRow's "AI decides", against this
 * scene's own resolved global values. */
function SceneVisualDirectionModal({ dials, globalDials, globalMood, onChange, onClose }: {
  dials: BulkVisualDialsRecord;
  globalDials: BulkVisualDialsRecord;
  globalMood: string | null;
  onChange: (patch: Partial<BulkVisualDialsRecord>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal dial-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Visual Direction — scene override</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 10px"}}>Leave any dial on "Inherit" to use this video's global value for it.</p>
        <div className="dial-grid">
          <SceneDialRow label="Visual Interpretation" hint="Literal ↔ Creative" value={dials.visualInterpretation} globalValue={globalDials.visualInterpretation} onChange={(value) => onChange({ visualInterpretation: value })} />
          <SceneDialRow label="Visual Metaphor" hint="Literal ↔ Symbolic" value={dials.visualMetaphor} globalValue={globalDials.visualMetaphor} onChange={(value) => onChange({ visualMetaphor: value })} />
          <SceneDialRow label="Cinematic Intensity" hint="Documentary ↔ Cinematic" value={dials.cinematicIntensity} globalValue={globalDials.cinematicIntensity} onChange={(value) => onChange({ cinematicIntensity: value })} />
          <SceneDialRow label="Prompt Creativity" hint="Strict script ↔ Highly creative" value={dials.promptCreativity} globalValue={globalDials.promptCreativity} onChange={(value) => onChange({ promptCreativity: value })} />
          <MoodRow level="scene" mood={dials.mood} moodMode={dials.moodMode} globalMood={globalMood} onChange={(mood, moodMode) => onChange({ mood, moodMode })} />
        </div>
        <button className="primary full" style={{marginTop:"14px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

function SceneDiversityConsistencyModal({ dials, globalDials, onChange, onClose }: {
  dials: BulkVisualDialsRecord;
  globalDials: BulkVisualDialsRecord;
  onChange: (patch: Partial<BulkVisualDialsRecord>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal dial-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Diversity &amp; Consistency — scene override</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 10px"}}>Leave any dial on "Inherit" to use this video's global value for it.</p>
        <div className="dial-grid">
          <SceneDialRow label="Camera Angle Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityCamera} globalValue={globalDials.diversityCamera} onChange={(value) => onChange({ diversityCamera: value })} />
          <SceneDialRow label="Composition Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityComposition} globalValue={globalDials.diversityComposition} onChange={(value) => onChange({ diversityComposition: value })} />
          <SceneDialRow label="Shot Type Diversity" hint="Consistent ↔ Dynamic" value={dials.diversityShotType} globalValue={globalDials.diversityShotType} onChange={(value) => onChange({ diversityShotType: value })} />
          <SceneDialRow label="Character Identity Strictness" hint="Flexible ↔ Strict" value={dials.consistencyCharacter} globalValue={globalDials.consistencyCharacter} onChange={(value) => onChange({ consistencyCharacter: value })} />
          <SceneDialRow label="Location Identity Strictness" hint="Flexible ↔ Strict" value={dials.consistencyLocation} globalValue={globalDials.consistencyLocation} onChange={(value) => onChange({ consistencyLocation: value })} />
          <SceneDialRow label="Style Strictness" hint="Flexible ↔ Strict" value={dials.consistencyStyle} globalValue={globalDials.consistencyStyle} onChange={(value) => onChange({ consistencyStyle: value })} />
        </div>
        <button className="primary full" style={{marginTop:"14px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Extract Style's "which aspects to focus on" popup — grouped checkboxes
 * over the static 29-item EXTRACTABLE_STYLE_ASPECTS list from the backend. */
const STYLE_ASPECT_GROUPS: { label: string; keys: string[] }[] = [
  { label: "Overall Style", keys: ["STY", "REN", "STYLE_SIG"] },
  { label: "Subjects & Character", keys: ["SUB", "COST", "FAC", "GEST", "EXP"] },
  { label: "Setting", keys: ["ENV", "ARCH", "MAT", "PROP"] },
  { label: "Color & Light", keys: ["CLR", "LGT", "ATM"] },
  { label: "Camera & Composition", keys: ["CAM", "LENS", "CMP", "FRM", "PERS", "DEPTH"] },
  { label: "Structure & Detail", keys: ["STR", "HIER", "GEO", "LINE", "TEXT", "EDGE", "DETAIL"] },
  { label: "Effects", keys: ["FX"] },
];

function ExtractStyleAspectsModal({ aspects, selectedKeys, onToggle, onSelectAll, onSelectNone, onClose }: {
  aspects: StyleAspectRecord[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onClose: () => void;
}) {
  const byKey = new Map(aspects.map((aspect) => [aspect.key, aspect]));
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal aspects-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Extract Style — Aspects to Focus On</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 8px"}}>Choose exactly what Extract Style should pull from a reference image when writing the style directive. Everything selected by default.</p>
        <div className="aspects-select-all">
          <button type="button" className="link-button" onClick={onSelectAll}>Select all</button>
          <button type="button" className="link-button" onClick={onSelectNone}>Select none</button>
        </div>
        {STYLE_ASPECT_GROUPS.map((group) => (
          <div key={group.label} className="aspects-group">
            <div className="panel-section-heading" style={{marginTop:"14px"}}><h3>{group.label}</h3></div>
            <div className="aspects-checklist">
              {group.keys.map((key) => {
                const aspect = byKey.get(key);
                if (!aspect) return null;
                return (
                  <label key={key} className="aspects-checkbox-row" title={aspect.description}>
                    <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => onToggle(key)} />
                    <span>{aspect.label}</span>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <button className="primary full" style={{marginTop:"18px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

/** Global Bulk Settings' Visualization Type control — same launcher-button
 * checkbox-grid pattern as ExtractStyleAspectsModal (reuses its
 * .aspects-modal/.aspects-checklist CSS as-is), plus one checkbox above the
 * grid for the hard-rule toggle itself. The checked types below have NO
 * effect at all unless that toggle is on — there's deliberately no "soft
 * preference" state in between (see BulkGlobalVisualSettingsRecord). */
function VisualizationTypesModal({ types, hardRule, onChange, onClose }: {
  types: string[];
  hardRule: boolean;
  onChange: (patch: Partial<Pick<BulkGlobalVisualSettingsRecord, "visualizationTypes" | "visualizationHardRule">>) => void;
  onClose: () => void;
}) {
  const selected = new Set(types);
  function toggleType(type: string) {
    if (!hardRule) return;
    const next = new Set(selected);
    if (next.has(type)) next.delete(type); else next.add(type);
    onChange({ visualizationTypes: [...next] });
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal bulk-modal aspects-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading-row"><h2>Visualization Types</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
        <p className="viz-description">A separate axis from the AI's own shot framing — this is the overall image medium (photo, illustration, diagram, ...).</p>
        <label className="toggle-row">
          <span className="toggle-switch">
            <input type="checkbox" checked={!hardRule} onChange={(event) => onChange({ visualizationHardRule: !event.target.checked })} />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
          </span>
          <span>Let AI decide</span>
        </label>
        <p className="viz-description">{hardRule
          ? "Off — every still must be rendered as one of the checked types below."
          : "On (default) — the AI decides each still's visual medium based on the script."}
        </p>
        <div className={`aspects-select-all${hardRule ? "" : " disabled"}`}>
          <button type="button" className="link-button" disabled={!hardRule} onClick={() => onChange({ visualizationTypes: [...VISUALIZATION_TYPES] })}>Select all</button>
          <button type="button" className="link-button" disabled={!hardRule} onClick={() => onChange({ visualizationTypes: [] })}>Select none</button>
        </div>
        <div className={`aspects-checklist viz-types-list${hardRule ? "" : " disabled"}`}>
          {VISUALIZATION_TYPES.map((type) => (
            <label key={type} className="aspects-checkbox-row">
              <input type="checkbox" checked={selected.has(type)} disabled={!hardRule} onChange={() => toggleType(type)} />
              <span>{type}</span>
            </label>
          ))}
        </div>
        <button className="primary full" style={{marginTop:"18px"}} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// Module-level (outside ImagesView), keyed by videoId — must survive
// ImagesView unmounting entirely, not just re-rendering. Root-cause fix for
// a real double-runner bug: this used to be a per-mount useRef, reset to
// "stopped" on every mount. If Bulk Generation's queue runner (see
// runQueueRunner) was still in its PLANNING phase (before a
// "generationStarted" result) when the user navigated to another tab,
// nothing stopped its background while-loop — it kept running against the
// OLD ref. Navigating back to Visuals remounted the component with a FRESH
// ref defaulting to "stopped", so the mount-time resume logic started a
// SECOND runQueueRunner loop, racing the first to advance the same
// plan_index cursor. Keeping this map at module scope means a remount reads
// the SAME "running" state the still-live background loop is maintaining,
// so its own guard correctly blocks the second start.
const bulkPlanControlByVideo = new Map<string, "running" | "paused" | "stopped">();
function getBulkPlanControl(videoId: string | null): "running" | "paused" | "stopped" {
  return bulkPlanControlByVideo.get(videoId ?? "") ?? "stopped";
}
function setBulkPlanControl(videoId: string | null, value: "running" | "paused" | "stopped") {
  bulkPlanControlByVideo.set(videoId ?? "", value);
}

function ImagesView() {
  const { activeVideoId, addToast, setStage, geminiLiveState } = useAppStore();
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  // Guards against overlapping refreshWorkspace() calls resolving out of
  // order — e.g. two browser-live imports landing a few hundred ms apart
  // (the worker loop can emit several render-imported events in one tick)
  // each fire their own refreshWorkspace(), and a slower-to-resolve older
  // request completing AFTER a faster newer one would silently overwrite
  // the newest data with a stale snapshot, making the latest imported
  // still look like it "never appeared." Only the response matching the
  // most recently issued request is applied.
  const refreshWorkspaceSeqRef = useRef(0);
  const stillListScrollRef = useRef<HTMLElement>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [multiSelectedGroupIds, setMultiSelectedGroupIds] = useState<Set<string>>(new Set());
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
  // Independent of `job` (Bulk Generation) — see SingleStillGenerationRecord.
  const [singleQueue, setSingleQueue] = useState<SingleStillGenerationRecord[]>([]);
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
  const [bulkInstruction, setBulkInstruction] = useState("");
  // "browser-live" plans via Claude CLI exactly like "api" does, but
  // dispatches each planned still to the connected Gemini Chrome extension
  // over the live connection instead of generating images itself here.
  // No per-request override anymore (that checkbox was removed from this
  // panel) — this always just reflects Preferences' generation_mode_default,
  // re-read fresh each time the panel opens, so switching it means going to
  // Preferences, not toggling it here.
  const [bulkGenerationMode, setBulkGenerationMode] = useState<"api" | "browser-live">("api");
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [preparingGroupIds, setPreparingGroupIds] = useState<Set<string>>(new Set());
  const [promptPrepStatus, setPromptPrepStatus] = useState<"running" | "paused" | null>(null);
  const promptPrepControl = useRef<"running" | "paused" | "stopped">("stopped");
  const promptPrepTask = useRef<{ items: ImageWorkspaceRecord["groups"]; index: number } | null>(null);
  // Drives the Bulk Generation QUEUE runner (see runQueueRunner) — the
  // planning-phase progress bar/controls (bulkPlanStatus/bulkProgress) still
  // mean exactly what they used to, just now sourced from whichever
  // request is currently active in the durable, backend-owned queue
  // instead of a single in-memory task.
  const [bulkPlanStatus, setBulkPlanStatus] = useState<"running" | "paused" | null>(null);
  const [bulkQueue, setBulkQueue] = useState<BulkGenerationRequestRecord[]>([]);
  const [liveRequestProgress, setLiveRequestProgress] = useState<{ total: number; imported: number } | null>(null);
  // Collapsed by default — the merged status bar shows just a "+N queued"
  // toggle; this expands it into the compact reorder/cancel list.
  const [bulkQueueExpanded, setBulkQueueExpanded] = useState(false);
  const [confirmingEnqueue, setConfirmingEnqueue] = useState(false);
  // Character/location roster + per-scene casting — replaces the old
  // single global/scene character+location reference model.
  const [rosterCharacters, setRosterCharacters] = useState<RosterCharacterRecord[]>([]);
  const [rosterLocations, setRosterLocations] = useState<RosterLocationRecord[]>([]);
  const [sceneCastAssignments, setSceneCastAssignments] = useState<SceneCastAssignmentRecord[]>([]);
  const [rosterModalOpen, setRosterModalOpen] = useState(false);
  const [visualDirectionModalOpen, setVisualDirectionModalOpen] = useState(false);
  const [diversityModalOpen, setDiversityModalOpen] = useState(false);
  const [visualizationTypesModalOpen, setVisualizationTypesModalOpen] = useState(false);
  // Which scene's Visual Direction / Diversity & Consistency modal is
  // open — at most one of either kind at a time, across every scene row
  // (mirrors bulkOverrideOpenSceneId's "one scene's drawer at a time").
  const [sceneDialModal, setSceneDialModal] = useState<{ sceneId: string; kind: "visual" | "diversity" } | null>(null);
  const [suggestingCast, setSuggestingCast] = useState(false);
  // Extract Style's selectable-aspects popup — the 29-item list is static,
  // fetched once; the user's selection persists per video via app_settings.
  const [extractStyleAspects, setExtractStyleAspects] = useState<StyleAspectRecord[]>([]);
  const [extractStyleAspectsOpen, setExtractStyleAspectsOpen] = useState(false);
  const [selectedAspectKeys, setSelectedAspectKeys] = useState<Set<string> | null>(null);
  const [referenceUrl, setReferenceUrl] = useState("");
  const promptPrepSettingKey = activeVideoId ? `prompt_prep.${activeVideoId}` : "";
  // The old flat "Generate All Stills" modal became a scene-sectioned
  // selection panel — bulkOpen still controls that panel; bulkGlobalOpen is
  // the nested dialog holding the same Style Directive/Reference Image/
  // Character Consistency/Creative Instructions form the panel used to be.
  const [bulkGlobalOpen, setBulkGlobalOpen] = useState(false);
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set());
  const [bulkSceneSettings, setBulkSceneSettings] = useState<BulkSceneSettingsRecord[]>([]);
  const [bulkGlobalVisualSettings, setBulkGlobalVisualSettings] = useState<BulkGlobalVisualSettingsRecord>(emptyBulkGlobalVisualSettings);
  const [bulkStillSettings, setBulkStillSettings] = useState<BulkStillSettingsRecord[]>([]);
  const [bulkOverrideOpenSceneId, setBulkOverrideOpenSceneId] = useState<string | null>(null);
  // Deliberately NOT the shared visual_plan_scenes.expanded flag — the Bulk
  // Generation panel's collapse state is its own local, ephemeral thing,
  // independent of the Visual Plan tab / Images left pane's toggle. Reset
  // fresh (first scene open, rest collapsed) every time the panel opens.
  const [bulkExpandedScenes, setBulkExpandedScenes] = useState<Record<string, boolean>>({});

  // Same helper, same scene data as the Visual Plan tab's SceneStrip
  // sections — this is what sections the left pane's still list (and the
  // Bulk Generation panel) by scene. sectionGroupsByScene wants sceneId at
  // the top level, so each workspace group is enriched with its nested
  // group.sceneId rather than sectioning bare PlanGroupRecords and losing
  // the prompt/render data every section item needs to render.
  const stillSections = useMemo(
    () => (workspace
      ? sectionGroupsByScene(
          workspace.groups.map((item) => ({ ...item, sceneId: item.group.sceneId })),
          workspace.scenes,
        )
      : []),
    [workspace],
  );

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
      // Switching videos should never carry a stale multi-selection
      // referencing another video's stills over into the newly opened one.
      setMultiSelectedGroupIds(new Set());
      const cached = imageWorkspaceCache.get(activeVideoId);
      if (cached) {
        setWorkspace(cached);
        // selectedRenderId must always track whichever group selectedGroupId
        // actually resolves to here (restored selection, or the first
        // group) - NOT unconditionally the first group's own render. Get
        // it wrong and a still that isn't actually group 0 renders group
        // 0's image (in both this thumbnail and the main preview) until
        // the next click through selectGroup recomputes it correctly -
        // resolvedGroupId captures the id setSelectedGroupId's updater
        // just resolved, since the updater callback runs synchronously.
        let resolvedGroupId: string | null = null;
        setSelectedGroupId((current) => {
          const restore = lastSelectedStill.get(activeVideoId);
          const next = restore && cached.groups.some((g) => g.group.id === restore)
            ? restore
            : current ?? cached.groups[0]?.group.id ?? null;
          resolvedGroupId = next;
          return next;
        });
        const selectedFromCache = cached.groups.find((g) => g.group.id === resolvedGroupId);
        setSelectedRenderId(finalOrNewestRender(selectedFromCache)?.id ?? null);
      }
      // The visual plan changed since Images last explicitly synced to it
      // (a recalculation, or a move/split/merge/reset in the Visual Plan
      // tab) and this mount wasn't reached via "Continue to images →" -
      // keep showing exactly what's cached and skip the fetch below
      // entirely, rather than silently pulling in the new still structure
      // (which would also reintroduce the stale-cache-then-fresh-swap
      // flash this guard exists to prevent). Still dirty either way: it's
      // only cleared by continueToImages, never by a plain visit here.
      if (cached && imagesPlanDirty.has(activeVideoId)) {
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(!cached);
      setError(null);
      try {
        const loaded = await projectsClient.getImageWorkspace(activeVideoId);
        setCached(activeVideoId, loaded);
        setWorkspace(loaded);
        // See the identical comment on the cached-branch above: everything
        // derived below (selectedRenderId, and the systemPrompt/userPrompt
        // fallback) must come from whichever group this resolves to, never
        // unconditionally loaded.groups[0] - group[0] is only "selected"
        // when nothing else was restored.
        let resolvedGroupId: string | null = null;
        setSelectedGroupId((current) => {
          const restore = lastSelectedStill.get(activeVideoId);
          const next = restore && loaded.groups.some((g) => g.group.id === restore)
            ? restore
            : current && loaded.groups.some((g) => g.group.id === current)
              ? current
              : loaded.groups[0]?.group.id ?? null;
          resolvedGroupId = next;
          return next;
        });
        const selectedFromLoaded = loaded.groups.find((g) => g.group.id === resolvedGroupId);
        // Both keyed per-video (`.${activeVideoId}` suffix) — these used to be
        // one shared key across every video in the workspace, so a style
        // directive or settings tweak on one video silently bled into
        // whichever video was opened next. A brand-new video with nothing
        // saved under its own key correctly falls through to that video's
        // own latest prompt version (or empty), never another video's.
        setImageSettings(parseImageSettings(loaded.settings.find((setting) => setting.key === `image_settings.${activeVideoId}`)?.value));
        const inputs = await projectsClient.getVideoInputs(activeVideoId);
        setReferences(inputs.references);
        const latestJob = await projectsClient.getLatestImageJob(activeVideoId);
        setJob(latestJob && ["queued", "running", "paused", "stopped", "failed"].includes(latestJob.status) ? latestJob : null);
        setSingleQueue(await projectsClient.listSingleStillGenerations(activeVideoId));
        const latest = selectedFromLoaded?.promptVersions[0];
        setSystemPrompt(loaded.settings.find((s) => s.key === `system_prompt.${activeVideoId}`)?.value ?? latest?.systemPrompt ?? "");
        setUserPrompt(latest?.userPrompt ?? "");
        // Per-video, same reasoning as systemPrompt/imageSettings above —
        // this used to be a single localStorage key shared across every
        // video, so a Creative Instructions note written for one video
        // silently leaked into whichever video was opened next.
        setBulkInstruction(loaded.settings.find((s) => s.key === `bulk_instruction.${activeVideoId}`)?.value ?? "");
        setSelectedRenderId(finalOrNewestRender(selectedFromLoaded)?.id ?? null);
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
        // Durable, backend-owned queue (see enqueueBulkGeneration/
        // runQueueRunner) — replaces the old single `bulk_plan.{videoId}`
        // app-setting cursor entirely. Any request left `pending` or
        // `planning` from before the app closed just resumes on its own:
        // `advanceBulkGenerationQueue` is safe to call unconditionally
        // (reports "idle" if there's nothing to do), so this always
        // reflects the queue's true state rather than requiring a manual
        // Resume click for a run that was merely interrupted by a restart.
        const queue = await projectsClient.listBulkGenerationRequests(activeVideoId);
        setBulkQueue(queue);
        if (queue.some((request) => ["pending", "planning", "generating"].includes(request.status))) {
          void runQueueRunner();
        }
      } catch (caught) {
        setError(String(caught));
      } finally {
        setLoading(false);
      }
    }
    void loadWorkspace();
  }, [activeVideoId]);

  // Restores the stills list's scroll position once, the next time this
  // view mounts for the video — ImagesView fully unmounts on every stage
  // switch, so a scroll-position ref set here doesn't survive on its own.
  // Guarded to run once per video load (not on every subsequent workspace
  // refresh) via restoredScrollForVideoRef, same pattern as Timeline/Visual
  // Plan's equivalents.
  const restoredScrollForVideoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeVideoId || !workspace || restoredScrollForVideoRef.current === activeVideoId) return;
    restoredScrollForVideoRef.current = activeVideoId;
    const remembered = lastVisualsStillListScrollTop.get(activeVideoId);
    if (remembered !== undefined && stillListScrollRef.current) stillListScrollRef.current.scrollTop = remembered;
  }, [activeVideoId, workspace]);

  useEffect(() => {
    if (!activeVideoId || !job || !["queued", "running"].includes(job.status)) return;
    const timer = window.setInterval(async () => {
      const latest = await projectsClient.getLatestImageJob(activeVideoId);
      setJob(latest && ["queued", "running", "paused", "stopped", "failed"].includes(latest.status) ? latest : null);
      const refreshed = await projectsClient.getImageWorkspace(activeVideoId);
      setWorkspace(refreshed);
      const selected = refreshed.groups.find((item) => item.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest && newest.id !== selectedRenderId) setSelectedRenderId(newest.id);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeVideoId, job, selectedGroupId, selectedRenderId]);

  // Polls the standalone single-still queue, independent of the bulk `job`
  // poll above — several single-still generations can be in flight/queued
  // even with no Bulk Generation job active at all.
  useEffect(() => {
    if (!activeVideoId || !singleQueue.some((item) => ["queued", "running"].includes(item.status))) return;
    const timer = window.setInterval(async () => {
      const latest = await projectsClient.listSingleStillGenerations(activeVideoId);
      setSingleQueue(latest);
      const refreshed = await projectsClient.getImageWorkspace(activeVideoId);
      setWorkspace(refreshed);
      const selected = refreshed.groups.find((item) => item.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest && newest.id !== selectedRenderId) setSelectedRenderId(newest.id);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeVideoId, singleQueue, selectedGroupId, selectedRenderId]);

  // Keeps the Bulk Generation queue list/hint in sync with its own status,
  // independent of the job-status poll above. Tying this to `job` (an
  // earlier version did) missed a real race: the background worker for a
  // small request (e.g. 2 stills) can finish before this component's own
  // getImageWorkspace/getLatestImageJob round trip even completes, so `job`
  // sometimes never settles into an observably "still running" state at
  // all — it goes straight from unset to null, and a poll gated on `job`
  // being truthy never starts, leaving `bulkQueue` frozen at whatever it
  // was the instant the request started generating. This poll is gated on
  // the queue's own status instead, so it can't miss that transition.
  useEffect(() => {
    if (!activeVideoId) return;
    const hasActiveRequest = bulkQueue.some((request) => ["pending", "planning", "generating"].includes(request.status));
    if (!hasActiveRequest) return;
    const timer = window.setInterval(async () => {
      try {
        const queue = await projectsClient.listBulkGenerationRequests(activeVideoId);
        setBulkQueue(queue);
        if (queue.some((request) => request.status === "pending") && !queue.some((request) => ["planning", "generating"].includes(request.status))) {
          void runQueueRunner();
        }
      } catch { /* Transient — the next tick (or the next video open) retries. */ }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeVideoId, bulkQueue]);

  // Live-refresh when the Gemini extension's worker loop imports a render
  // for the video currently open here — independent of every poll above,
  // all of which are gated on the frontend's own idea of "something's in
  // flight" (an image_jobs/single_still_generations/bulkQueue status), none
  // of which a browser-live import touches on its own. `lastImportEventSeq`
  // is a monotonic counter (not a boolean) specifically so a second import
  // for the same video still re-triggers this effect.
  useEffect(() => {
    if (!activeVideoId || geminiLiveState.lastImportedVideoId !== activeVideoId) return;
    void refreshWorkspace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geminiLiveState.lastImportEventSeq]);

  async function refreshWorkspace() {
    if (!activeVideoId) return;
    const seq = ++refreshWorkspaceSeqRef.current;
    try {
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      if (refreshWorkspaceSeqRef.current !== seq) return; // superseded by a newer refresh — drop this stale result
      setCached(activeVideoId, loaded);
      setWorkspace(loaded);
      const selected = loaded.groups.find((group) => group.group.id === selectedGroupId);
      const newest = selected?.imageRenders[0];
      if (newest) setSelectedRenderId(newest.id);
    } catch (caught) {
      if (refreshWorkspaceSeqRef.current === seq) setError(String(caught));
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

  /** Queues this still on the standalone single-still generation queue
   * (see SingleStillGenerationRecord) instead of generating synchronously —
   * returns as soon as the item is queued, not once the image is actually
   * generated, so the button (and every other still) stays usable while it
   * runs in the background. `generatingGroupId` here only covers the brief
   * create-prompt-version + enqueue round trip, to prevent a double-submit
   * of the same still — actual generation progress is tracked via
   * `singleQueue`, polled separately. */
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
      const queued = await projectsClient.enqueueSingleStillGeneration(activeVideoId, selectedGroupId, versionId);
      setSingleQueue((current) => [...current, queued]);
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
      const updated = await projectsClient.controlImageJob(job.id, action);
      // "cancel" (the UI's Stop button) and "stop" are both explicit,
      // final "I'm done looking at this" actions — even though the
      // backend leaves the job row itself at 'failed'/'stopped' (so a
      // *natural* mid-run failure can still show "Retry N failed stills"),
      // a user-initiated stop should just clear the status box rather than
      // leave it sitting there indefinitely.
      setJob(action === "stop" || action === "cancel" ? null : updated);
    } catch (caught) {
      setError(String(caught));
    }
  }

  function selectGroup(groupId: string) {
    setError(null);
    setSelectedGroupId(groupId);
    if (activeVideoId) lastSelectedStill.set(activeVideoId, groupId);
    const latest = workspace?.groups.find((item) => item.group.id === groupId)?.promptVersions[0];
    const videoDirective = activeVideoId ? workspace?.settings.find((s) => s.key === `system_prompt.${activeVideoId}`)?.value : undefined;
    setSystemPrompt(videoDirective ?? latest?.systemPrompt ?? "");
    setUserPrompt(latest?.userPrompt ?? "");
    setImageSettings(parseImageSettings(latest?.settingsJson));
    setSelectedRenderId(finalOrNewestRender(workspace?.groups.find((item) => item.group.id === groupId))?.id ?? null);
  }

  // Ctrl/Cmd+click toggles multi-select membership, independent of the
  // single-preview selection. A plain click just changes the preview (like
  // it always did) and deliberately leaves any multi-selection untouched —
  // it only clears via Escape or by Ctrl+clicking an already-selected still
  // again, so browsing other stills while multi-selecting doesn't lose it.
  function handleStillClick(event: ReactMouseEvent, groupId: string) {
    if (event.ctrlKey || event.metaKey) {
      setMultiSelectedGroupIds((current) => {
        const next = new Set(current);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        return next;
      });
      return;
    }
    selectGroup(groupId);
  }

  // Same underlying flag as VisualPlanView's setSceneExpanded (both read/
  // write visual_plan_scenes.expanded via the same command) — toggling a
  // scene here is reflected on the Visual Plan tab and vice versa. Splices
  // the returned plan's scenes into local workspace state rather than
  // refetching the whole workspace.
  async function setImageSceneExpanded(sceneId: string, expanded: boolean) {
    if (!activeVideoId) return;
    try {
      const plan = await projectsClient.setPlanSceneExpanded(activeVideoId, sceneId, expanded);
      setWorkspace((current) => (current ? { ...current, scenes: plan.scenes } : current));
    } catch (caught) {
      setError(String(caught));
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
        setJob(await projectsClient.createImageJob(activeVideoId, task.items.map((item) => item.group.id)));
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

  async function refreshBulkQueue() {
    if (!activeVideoId) return;
    try {
      setBulkQueue(await projectsClient.listBulkGenerationRequests(activeVideoId));
    } catch { /* Best-effort — the next poll/reopen will catch up. */ }
  }

  // The Bulk Generation queue's single runner loop — call it any time
  // something MIGHT be due (after enqueueing, on Resume, on video open, and
  // after the active request's generation job finishes) rather than trying
  // to track state transitions precisely; it's always safe to call
  // (idempotent no-op via the bulkPlanControl guard below, and
  // advanceBulkGenerationQueue itself reports "idle" when there's nothing
  // queued). Only the ACTIVE request's planning phase is driven from here —
  // once it starts generating, this hands off to the existing job-status
  // polling effect and stops, exactly like the old single-request flow did.
  async function runQueueRunner() {
    if (!activeVideoId || getBulkPlanControl(activeVideoId) === "running") return;
    const videoId = activeVideoId;
    setBulkPlanControl(videoId, "running");
    setBulkPlanStatus("running");
    // A single advanceBulkGenerationQueue call can legitimately take a long
    // time to resolve (a "high effort" Claude CLI planning call especially)
    // — bulkProgress otherwise stays null for that entire stretch, since it
    // only gets populated once a "planned" result actually comes back, so
    // the whole queue/progress UI would render nothing at all while a
    // request just sits there working. Show something immediately instead;
    // the first real result overwrites this right away.
    setBulkProgress({ current: 0, total: 0, label: "Starting Bulk Generation…" });
    try {
      while (getBulkPlanControl(videoId) === "running") {
        const result = await projectsClient.advanceBulkGenerationQueue(videoId);
        if (getBulkPlanControl(videoId) !== "running") break;
        if (result.kind === "idle") {
          setBulkPlanControl(videoId, "stopped");
          setBulkPlanStatus(null);
          setBulkProgress(null);
          break;
        } else if (result.kind === "planned") {
          setBulkProgress({ current: result.current, total: result.total, label: `Still ${result.current} of ${result.total} planned` });
          continue;
        } else if (result.kind === "liveDispatching") {
          // No image_jobs row exists for a browser-live request — rows are
          // being pushed one at a time to the connected Gemini extension by
          // the backend's worker loop instead. Nothing to hand off to the
          // job-status poll; the existing bulk-queue poll (keyed on request
          // status, below) picks up progress from here and the request
          // flips to 'completed' on its own once every row has imported.
          setBulkPlanStatus(null);
          setBulkProgress(null);
          setBulkPlanControl(videoId, "stopped");
          // Clear any stale job from an earlier api-mode run — otherwise
          // the merged status bar keeps showing that old job's status
          // (e.g. a leftover "failed") instead of this request's own
          // browser-live progress, since `job` is never touched by this
          // branch and getLatestImageJob() isn't re-fetched here.
          setJob(null);
          addToast("Generating via the Gemini Chrome extension — images will appear in the Images tab as they finish", "success");
          break;
        }
        // "generationStarted" or "generationInProgress" — this request's
        // planning is done (just now, or from before this session); the
        // existing job-status UI/polling takes over from here.
        setBulkPlanStatus(null);
        setBulkProgress(null);
        setBulkPlanControl(videoId, "stopped");
        const live = await projectsClient.getImageWorkspace(videoId);
        setCached(videoId, live);
        setWorkspace(live);
        if (selectedGroupId) {
          const group = live.groups.find((g) => g.group.id === selectedGroupId);
          const pv = group?.promptVersions[0];
          if (pv) {
            setImageSettings(parseImageSettings(pv.settingsJson));
            setUserPrompt(pv.userPrompt);
            const videoDirective = live.settings.find((s) => s.key === `system_prompt.${videoId}`)?.value;
            setSystemPrompt(videoDirective ?? pv.systemPrompt ?? systemPrompt);
          }
        }
        const latestJob = await projectsClient.getLatestImageJob(videoId);
        setJob(latestJob && ["queued", "running", "paused", "stopped", "failed"].includes(latestJob.status) ? latestJob : null);
        if (result.kind === "generationStarted") addToast("Bulk Generation started", "success");
        break;
      }
    } catch (caught) {
      setError(String(caught));
      // Leave the request exactly where it is (its plan_index cursor is
      // already durable on the backend) — Resume just calls this again.
      setBulkPlanControl(videoId, "paused");
      setBulkPlanStatus("paused");
      // A thrown advanceBulkGenerationQueue call (e.g. a transient IPC hiccup
      // during a dev rebuild) can still have fully succeeded backend-side —
      // the request may already be 'generating' even though this call never
      // got to see that. Without clearing this, the "Starting Bulk
      // Generation…" placeholder set above stays stuck forever, and the
      // status bar's display logic checks bulkProgress before
      // activeLiveRequest — so a real, correctly-progressing generation
      // stays hidden behind a stale placeholder from the failed call that
      // preceded it. refreshBulkQueue() below will pick up the true state.
      setBulkProgress(null);
    } finally {
      await refreshBulkQueue();
    }
  }

  function controlBulkPlan(action: "pause" | "resume" | "stop") {
    if (action === "pause") {
      setBulkPlanControl(activeVideoId, "paused");
      setBulkPlanStatus("paused");
    } else if (action === "resume") {
      void runQueueRunner();
    } else if (action === "stop") {
      setBulkPlanControl(activeVideoId, "stopped");
      setBulkPlanStatus(null);
      setBulkProgress(null);
      // Abandons only the request that's actively planning right now — the
      // rest of the queue (if any) is untouched and the runner will pick up
      // the next pending request the next time something invokes it.
      const active = bulkQueue.find((request) => request.status === "planning");
      if (active) {
        void projectsClient.cancelBulkGenerationRequest(active.id).then(refreshBulkQueue).catch((caught) => setError(String(caught)));
      }
    }
  }

  // Ordered scene-then-ordinal (matching stillSections' render order, which
  // Rust's plan_bulk_visuals_batch relies on for its scene-bounded
  // chunking) — not Array.from(bulkSelection)'s arbitrary insertion order.
  const orderedBulkSelection = stillSections
    .flatMap((section) => section.groups)
    .map((group) => group.group.id)
    .filter((id) => bulkSelection.has(id));

  async function openBulkPanel() {
    if (!activeVideoId) return;
    setBulkOpen(true);
    setError(null);
    // Local, ephemeral collapse state — first scene open, rest collapsed —
    // reset fresh every time the panel opens, independent of the shared
    // Visual Plan / Images-pane expand flag.
    setBulkExpandedScenes(Object.fromEntries(
      stillSections.filter((section) => section.scene).map((section, index) => [section.scene!.id, index === 0]),
    ));
    try {
      const [pending, sceneSettings, globalVisual, stillSettings, characters, locations, assignments, modeDefault] = await Promise.all([
        projectsClient.pendingStillIds(activeVideoId),
        projectsClient.getBulkSceneSettings(activeVideoId),
        projectsClient.getBulkGlobalSettings(activeVideoId),
        projectsClient.getBulkStillSettings(activeVideoId),
        projectsClient.listRosterCharacters(activeVideoId),
        projectsClient.listRosterLocations(activeVideoId),
        projectsClient.getSceneCastAssignments(activeVideoId),
        projectsClient.getAppSetting("generation_mode_default"),
      ]);
      // Read fresh from Preferences each time the panel opens — see
      // bulkGenerationMode's own comment for why there's no in-panel
      // override anymore.
      setBulkGenerationMode(modeDefault === "browser-live" ? "browser-live" : "api");
      // A still-open multi-selection from the left pane wins over both the
      // remembered edit and the default "needs generation" set — Ctrl+click
      // there is a deliberate "generate exactly these" scoping gesture, so
      // it should carry straight into the panel it's opening for.
      setBulkSelection(multiSelectedGroupIds.size > 0 ? new Set(multiSelectedGroupIds) : lastBulkSelection.get(activeVideoId) ?? new Set(pending));
      setBulkSceneSettings(sceneSettings);
      setBulkGlobalVisualSettings(globalVisual);
      setBulkStillSettings(stillSettings);
      setRosterCharacters(characters);
      setRosterLocations(locations);
      setSceneCastAssignments(assignments);
      // Auto-suggest cast once per video: only when there's a roster to
      // cast against and no scene has ever had a suggestion run yet — a
      // later manual "Suggest cast" click re-runs it deliberately.
      if ((characters.length || locations.length) && assignments.length === 0) {
        const sceneIds = stillSections.map((section) => section.scene?.id).filter((id): id is string => Boolean(id));
        if (sceneIds.length) void suggestCast(sceneIds);
      }
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function saveGlobalVisualSettings(patch: Partial<BulkGlobalVisualSettingsRecord>) {
    if (!activeVideoId) return;
    const next: BulkGlobalVisualSettingsRecord = { ...bulkGlobalVisualSettings, ...patch };
    setBulkGlobalVisualSettings(next);
    try {
      await projectsClient.saveBulkGlobalSettings(activeVideoId, next.dials, next.visualizationTypes, next.visualizationHardRule);
    } catch (caught) {
      setError(String(caught));
    }
  }

  function updateGlobalDial(patch: Partial<BulkVisualDialsRecord>) {
    void saveGlobalVisualSettings({ dials: { ...bulkGlobalVisualSettings.dials, ...patch } });
  }

  async function refreshRoster() {
    if (!activeVideoId) return;
    const [characters, locations] = await Promise.all([
      projectsClient.listRosterCharacters(activeVideoId),
      projectsClient.listRosterLocations(activeVideoId),
    ]);
    setRosterCharacters(characters);
    setRosterLocations(locations);
  }

  async function addRosterCharacter() {
    if (!activeVideoId) return;
    try { await projectsClient.createRosterCharacter(activeVideoId, `Character ${rosterCharacters.length + 1}`); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function addRosterLocation() {
    if (!activeVideoId) return;
    try { await projectsClient.createRosterLocation(activeVideoId, `Location ${rosterLocations.length + 1}`); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function renameRosterCharacter(id: string, name: string) {
    try { await projectsClient.renameRosterCharacter(id, name); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function renameRosterLocation(id: string, name: string) {
    try { await projectsClient.renameRosterLocation(id, name); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function removeRosterCharacter(id: string) {
    try { await projectsClient.deleteRosterCharacter(id); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function removeRosterLocation(id: string) {
    try { await projectsClient.deleteRosterLocation(id); await refreshRoster(); }
    catch (caught) { setError(String(caught)); }
  }

  async function importRosterCharacterReference(characterId: string) {
    if (!activeVideoId) return;
    try {
      const asset = await projectsClient.pickAndImportAsset(activeVideoId, "roster-reference");
      if (asset) { await projectsClient.setRosterCharacterReference(characterId, asset.id); await refreshRoster(); }
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function importRosterLocationReference(locationId: string) {
    if (!activeVideoId) return;
    try {
      const asset = await projectsClient.pickAndImportAsset(activeVideoId, "roster-reference");
      if (asset) { await projectsClient.setRosterLocationReference(locationId, asset.id); await refreshRoster(); }
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function saveCastAssignment(sceneId: string, characterIds: string[], locationId: string | null) {
    if (!activeVideoId) return;
    try {
      const saved = await projectsClient.saveSceneCastAssignment(activeVideoId, sceneId, characterIds, locationId);
      setSceneCastAssignments((items) => [...items.filter((item) => item.sceneId !== sceneId), saved]);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function suggestCast(sceneIds: string[]) {
    if (!activeVideoId || !sceneIds.length) return;
    setSuggestingCast(true);
    try {
      const suggested = await projectsClient.suggestSceneCastBatch(activeVideoId, sceneIds);
      setSceneCastAssignments((items) => {
        const suggestedIds = new Set(suggested.map((item) => item.sceneId));
        return [...items.filter((item) => !suggestedIds.has(item.sceneId)), ...suggested];
      });
    } catch (caught) {
      setError(String(caught));
    } finally {
      setSuggestingCast(false);
    }
  }

  // Extract Style's aspects popup — the 29-item list is static (fetched
  // once and cached in state); the user's selection persists per video via
  // the generic app_settings key extract_style_aspects.{videoId}, same
  // pattern as system_prompt.{videoId}. No selection saved yet, or an
  // empty selection, both mean "focus on everything" (matching the
  // backend's own safeguard against a degenerate empty-focus prompt).
  async function openExtractStyleAspects() {
    if (!activeVideoId) return;
    try {
      let aspects = extractStyleAspects;
      if (!aspects.length) {
        aspects = await projectsClient.listExtractableStyleAspects();
        setExtractStyleAspects(aspects);
      }
      const saved = await projectsClient.getAppSetting(`extract_style_aspects.${activeVideoId}`);
      let keys: string[] = [];
      if (saved) {
        try { keys = JSON.parse(saved) as string[]; } catch { keys = []; }
      }
      setSelectedAspectKeys(new Set(keys.length ? keys : aspects.map((aspect) => aspect.key)));
      setExtractStyleAspectsOpen(true);
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function persistSelectedAspects(keys: Set<string>) {
    if (!activeVideoId) return;
    await projectsClient.saveAppSetting(`extract_style_aspects.${activeVideoId}`, JSON.stringify(Array.from(keys)));
  }

  async function toggleExtractStyleAspect(key: string) {
    if (!selectedAspectKeys) return;
    const next = new Set(selectedAspectKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelectedAspectKeys(next);
    await persistSelectedAspects(next);
  }

  async function setAllExtractStyleAspects(all: boolean) {
    const next = all ? new Set(extractStyleAspects.map((aspect) => aspect.key)) : new Set<string>();
    setSelectedAspectKeys(next);
    await persistSelectedAspects(next);
  }

  function toggleBulkSceneExpanded(sceneId: string) {
    setBulkExpandedScenes((current) => ({ ...current, [sceneId]: !current[sceneId] }));
  }

  // Generate always enqueues (never blocks on an active/queued request) —
  // if the queue already has something in it, confirm first since the user
  // may not realize this run will wait its turn rather than starting right
  // away; an empty queue enqueues and starts immediately with no prompt.
  function requestEnqueueBulkGeneration() {
    if (!activeVideoId || !orderedBulkSelection.length || !systemPrompt.trim()) return;
    const hasQueued = bulkQueue.some((request) => !["completed", "failed", "cancelled"].includes(request.status));
    if (hasQueued) {
      setConfirmingEnqueue(true);
      return;
    }
    void enqueueBulkGeneration();
  }

  async function enqueueBulkGeneration() {
    if (!activeVideoId || !orderedBulkSelection.length || !systemPrompt.trim()) return;
    setBulkOpen(false);
    setError(null);
    try {
      await projectsClient.saveAppSetting(`system_prompt.${activeVideoId}`, systemPrompt);
      await projectsClient.enqueueBulkGenerationRequest(activeVideoId, systemPrompt, settingsJson, bulkInstruction, orderedBulkSelection, bulkGenerationMode);
      lastBulkSelection.delete(activeVideoId);
      addToast(`${orderedBulkSelection.length} still${orderedBulkSelection.length === 1 ? "" : "s"} added to the Bulk Generation queue`, "success");
      await refreshBulkQueue();
      void runQueueRunner();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function cancelQueuedRequest(requestId: string) {
    try {
      await projectsClient.cancelBulkGenerationRequest(requestId);
      await refreshBulkQueue();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function reorderQueuedRequest(requestId: string, direction: "up" | "down") {
    try {
      await projectsClient.reorderBulkGenerationRequest(requestId, direction);
      await refreshBulkQueue();
    } catch (caught) {
      setError(String(caught));
    }
  }

  async function saveSceneOverride(sceneId: string, patch: Partial<Omit<BulkSceneSettingsRecord, "sceneId">>) {
    if (!activeVideoId) return;
    const current = bulkSceneSettings.find((item) => item.sceneId === sceneId);
    const next: BulkSceneSettingsRecord = {
      sceneId,
      styleDirective: current?.styleDirective ?? null,
      creativeInstruction: current?.creativeInstruction ?? null,
      dials: current?.dials ?? emptyBulkVisualDials(),
      ...patch,
    };
    setBulkSceneSettings((items) => [...items.filter((item) => item.sceneId !== sceneId), next]);
    try {
      await projectsClient.saveBulkSceneSettings(activeVideoId, sceneId, next.styleDirective, next.creativeInstruction, next.dials);
    } catch (caught) {
      setError(String(caught));
    }
  }

  // Every path that changes bulkSelection writes through to
  // lastBulkSelection so the edit survives closing and reopening the panel
  // (see openBulkPanel/lastBulkSelection's own comment).
  function rememberBulkSelection(next: Set<string>) {
    if (activeVideoId) lastBulkSelection.set(activeVideoId, next);
    return next;
  }

  function toggleBulkStill(groupId: string) {
    setBulkSelection((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return rememberBulkSelection(next);
    });
  }

  function toggleBulkScene(groupIds: string[]) {
    setBulkSelection((current) => rememberBulkSelection(toggleScene(groupIds, current)));
  }

  function updateImageSetting<K extends keyof ImageSettings>(key: K, value: ImageSettings[K]) {
    setImageSettings((current) => ({ ...current, [key]: value }));
  }

  // Auto-save image settings whenever they change (replaces the removed "Apply settings"
  // button) — keyed per-video, same reasoning as systemPrompt above: this panel's fields
  // are this video's own composition defaults, not something every other video should
  // inherit.
  useEffect(() => {
    if (!activeVideoId) return;
    const timer = window.setTimeout(() => {
      void projectsClient.saveAppSetting(`image_settings.${activeVideoId}`, settingsJson);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [settingsJson, activeVideoId]);

  // Bulk Generation's Creative Instructions field — per-video, same pattern
  // as imageSettings above. This used to be a single global localStorage
  // key shared across every video (see git history); moving it here fixes
  // that leak and gives it the same "survives closing the modal" behavior
  // every other Bulk Generation setting already has.
  useEffect(() => {
    if (!activeVideoId) return;
    const timer = window.setTimeout(() => {
      void projectsClient.saveAppSetting(`bulk_instruction.${activeVideoId}`, bulkInstruction);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [bulkInstruction, activeVideoId]);

  // Aspect ratio is the one field on this panel that's deliberately NOT per-video — it's
  // the same cross-view rendering choice the Editor/Animate stages read (still under the
  // legacy unscoped "image_settings" key, but narrowed to just this field via a
  // read-modify-write so it doesn't reintroduce the other fields' per-video bleed this
  // whole change is fixing).
  useEffect(() => {
    if (!activeVideoId) return;
    projectsClient.getAppSetting("image_settings").then((raw) => {
      let parsed: Record<string, unknown> = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* start fresh */ }
      if (parsed.aspectRatio === imageSettings.aspectRatio) return;
      void projectsClient.saveAppSetting("image_settings", JSON.stringify({ ...parsed, aspectRatio: imageSettings.aspectRatio }));
    }).catch(() => {});
  }, [imageSettings.aspectRatio, activeVideoId]);

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

  // Strips anything settings/subject-specific out of the Style Directive
  // (camera angle, lighting, named characters/objects, scene content —
  // whatever already has its own dedicated field elsewhere), leaving only
  // the global aesthetic rules a Style Directive is actually meant to
  // hold. Same handler for both textareas that edit this field (the main
  // Settings tab and Global Bulk Settings) since they already share this
  // one systemPrompt state.
  async function cleanStyleDirective() {
    if (!systemPrompt.trim()) return;
    setAiLoading(true);
    setError(null);
    try {
      // Text only — deliberately never touches imageSettings. Those may
      // already hold real values pulled from a reference image (Extract
      // Style) or set by hand; this button's only job is trimming
      // settings-language OUT of the directive prose, not re-deriving or
      // overwriting the structured dials themselves.
      const extracted = await projectsClient.extractImageSettingsFromDirective(systemPrompt);
      setSystemPrompt(extracted.styleDirective);
    } catch (caught) { setError(String(caught)); }
    finally { setAiLoading(false); }
  }

  const previewLabel = selectedGroup?.group.label ?? "Still preview";
  const stillCount = workspace?.groups.length ?? 0;
  const pendingBulkRequests = bulkQueue.filter((request) => request.status === "pending");
  // A browser-live request has no image_jobs row, so `job`/`bulkProgress`
  // both go null the moment planning finishes (see runQueueRunner's
  // liveDispatching branch) — without this, the whole merged status bar
  // below would just disappear for the entire generating phase, even
  // though rows are actively (or about to be) dispatched to the extension.
  const activeLiveRequest = bulkQueue.find((request) => request.status === "generating" && request.generationMode === "browser-live");
  const imageRenders = selectedGroup?.imageRenders ?? [];

  // Row-completion progress for whichever browser-live request is active —
  // separate from the live-refresh effect above (that one refreshes the
  // still list/images; this one just drives the "X/Y imported" status-bar
  // text, and needs to keep polling even while the extension is
  // disconnected, e.g. to show "0/6 imported" while awaiting connection).
  useEffect(() => {
    if (!activeLiveRequest) { setLiveRequestProgress(null); return; }
    const requestId = activeLiveRequest.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const progress = await projectsClient.getCsvExportProgress(requestId);
        if (!cancelled) setLiveRequestProgress(progress);
      } catch { /* transient — next tick retries */ }
    };
    void poll();
    const timer = window.setInterval(poll, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeLiveRequest?.id]);

  useEffect(() => {
    const ids = [selectedRenderId].filter(Boolean) as string[];
    // Per-item catch: one failed resolve (now retryable next time thanks to
    // media-cache's cachedOrRetry, see resolveRenderUrl) shouldn't sink the
    // whole batch via an unhandled rejection, nor block the others.
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      try {
        const url = await resolveRenderUrl(id);
        setRenderUrls((current) => ({ ...current, [id]: url }));
      } catch { /* Transient — retried on the next render/poll. */ }
    }));
  }, [selectedRenderId, renderUrls]);

  useEffect(() => {
    // Both the thumbnail (always newest, so the list hints a fresher
    // generation exists) and the locked/final version if it differs from
    // newest — otherwise a still whose selected version is an older,
    // explicitly-locked one only gets its URL resolved reactively once it
    // becomes selectedRenderId (the effect above), which can read as "no
    // image generated yet" for a beat right after restoring a video whose
    // last-selected still is that locked version.
    const ids = workspace?.groups.flatMap((group) => {
      const newest = group.imageRenders[0]?.id;
      const final = finalOrNewestRender(group)?.id;
      return [newest, final].filter((id): id is string => Boolean(id));
    });
    if (!ids?.length) return;
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      try {
        const url = await resolveRenderUrl(id);
        setRenderUrls((current) => ({ ...current, [id]: url }));
      } catch { /* Transient — retried on the next render/poll. */ }
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
      setImageSettings(defaultImageSettings);
      const loaded = await projectsClient.getImageWorkspace(activeVideoId);
      setCached(activeVideoId, loaded);
      setWorkspace(loaded);
      setSelectedGroupId(loaded.groups[0]?.group.id ?? null);
      // The style directive is saved independently (system_prompt.{videoId}
      // app setting) — reset_image_workflow never touches it, only
      // prompt_versions/image_renders. Re-read it from the reloaded
      // workspace rather than leaving the field blank; a video that never
      // had one saved correctly falls back to empty.
      setSystemPrompt(loaded.settings.find((s) => s.key === `system_prompt.${activeVideoId}`)?.value ?? "");
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

  useEffect(() => {
    if (multiSelectedGroupIds.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMultiSelectedGroupIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [multiSelectedGroupIds.size]);

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
      // Persist as this video's sticky style directive too — otherwise the
      // apply only reaches the database rows, and reselecting a still (or
      // reopening the video later) could show a different, older directive
      // than what was just applied everywhere.
      await projectsClient.saveAppSetting(`system_prompt.${activeVideoId}`, systemPrompt);
      const refreshed = await projectsClient.getImageWorkspace(activeVideoId);
      setWorkspace(refreshed);
      setCached(activeVideoId, refreshed);
      addToast(`Style directive applied to ${count} prompt version${count !== 1 ? "s" : ""}.`, "success");
    } catch (caught) { setError(String(caught)); }
    finally { setApplyingStyle(false); }
  }

  return (
    <section className="view images-view">
      {loading && <LoadingOverlay label="Working on your images" />}
      {confirmReset && <ConfirmDialog title="Reset all images?" message="This clears all prompts, image versions, planner results, and still statuses for this video. This cannot be undone." confirmLabel="Reset everything" danger onConfirm={() => { setConfirmReset(false); void doResetImages(); }} onCancel={() => setConfirmReset(false)} />}
      {confirmingStop && <ConfirmDialog title="Stop bulk generation?" message="This will permanently stop the current job. Any stills already generated are kept, but remaining stills will not be generated and the job cannot be resumed." confirmLabel="Stop generation" onConfirm={() => { setConfirmingStop(false); void controlJob("cancel"); }} onCancel={() => setConfirmingStop(false)} />}
      {confirmingEnqueue && <ConfirmDialog title="Add to queue?" message="A Bulk Generation run is already active or queued for this video. This run will be added to the queue and start automatically once it's its turn." confirmLabel="Add to queue" onConfirm={() => { setConfirmingEnqueue(false); void enqueueBulkGeneration(); }} onCancel={() => setConfirmingEnqueue(false)} />}
      <div className="page-heading">
        <div>
          <h1>Image generation</h1>
          <p>Select a still, review prompt versions, and generate render outputs.</p>
        </div>
        <div className="heading-actions"><button className="secondary" onClick={() => void openBulkPanel()} disabled={!workspace?.groups.length || loading}><WandSparkles size={17} />Bulk Generation</button><button className="primary" onClick={() => setStage("animate")} disabled={!workspace?.groups.length}><Film size={17} />Continue to Animate →</button></div>
      </div>
      {error && <div className="error-toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
      <div className="image-workspace">
        <aside
          className="stills"
          ref={stillListScrollRef}
          onScroll={(event) => { if (activeVideoId) lastVisualsStillListScrollTop.set(activeVideoId, event.currentTarget.scrollTop); }}
        >
          <div className="stills-heading">
            <div className="stills-heading-left">
              <span className="stills-heading-label">Stills</span>
              <span className="stills-heading-count">{stillCount}</span>
            </div>
            <div className="stills-heading-actions">
              <button className="icon-button" title="Download all images" aria-label="Download all images" onClick={() => void exportStills()}><Download size={15} /></button>
              <button className="icon-button danger-action" title="Reset all images" aria-label="Reset all images" onClick={() => setConfirmReset(true)} disabled={loading}><Trash2 size={15} /></button>
            </div>
          </div>
          <div className="still-list">
            {stillSections.map((section, sectionIndex) => {
              const scene = section.scene;
              const collapsed = Boolean(scene && !scene.expanded);
              return (
                <div className="stills-scene-section" key={scene?.id ?? `no-scene-${sectionIndex}`}>
                  {scene && (
                    <LeftPaneSceneStrip
                      scene={scene}
                      stillCount={section.groups.length}
                      onToggle={() => void setImageSceneExpanded(scene.id, !scene.expanded)}
                    />
                  )}
                  {!collapsed && section.groups.map((group) => {
                    const newestPrompt = group.promptVersions[0];
                    const newestRender = group.imageRenders[0];
                    const isSelectedGroup = group.group.id === selectedGroupId;
                    const thumbUrl = isSelectedGroup && selectedRenderId
                      ? renderUrls[selectedRenderId]
                      : newestRender ? renderUrls[newestRender.id] : undefined;
                    const item = job?.items.find((candidate) => candidate.groupId === group.group.id);
                    // The single-still queue is independent of Bulk Generation's
                    // job (see SingleStillGenerationRecord) — matched the same
                    // way, by groupId, against its own list.
                    const singleItem = singleQueue.find((candidate) => candidate.groupId === group.group.id
                      && (candidate.status === "queued" || candidate.status === "running"));
                    const isPreparing = preparingGroupIds.has(group.group.id);
                    const isGeneratingBulk = item?.status === "running" || generatingGroupId === group.group.id;
                    const isGeneratingSingle = singleItem?.status === "running";
                    const isQueuedSingle = singleItem?.status === "queued";
                    const isGenerating = isGeneratingBulk || isGeneratingSingle;
                    const statusKey = isPreparing || isGenerating || isQueuedSingle ? "generating" : item?.status === "failed" ? "failed" : newestRender && newestPrompt && newestRender.promptVersionId !== newestPrompt.id ? "outdated" : newestRender ? "generated" : newestPrompt ? "ready" : "empty";
                    const statusLabel = isPreparing ? "Preparing prompt"
                      : isGeneratingSingle ? "Generating (single)"
                      : isGeneratingBulk ? "Generating (bulk)"
                      : isQueuedSingle ? "Queued (single)"
                      : statusKey === "failed" ? "Failed"
                      : statusKey === "outdated" ? "Outdated — regenerate"
                      : statusKey === "generated" ? "Generated"
                      : statusKey === "ready" ? "Prompt ready" : "No prompt yet";
                    const isMultiSelected = multiSelectedGroupIds.has(group.group.id);
                    return (
                      <button
                        key={group.group.id}
                        className={`still-select${group.group.id === selectedGroupId ? " active" : ""}${isMultiSelected ? " multi-selected" : ""}`}
                        title={statusLabel}
                        onClick={(event) => handleStillClick(event, group.group.id)}
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
                          {isMultiSelected && <span className="still-multi-check" aria-hidden="true"><Check size={12} /></span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {!workspace && <div className="empty-state">Loading stills…</div>}
          {multiSelectedGroupIds.size > 0 && (
            <div className="stills-multi-select-bar">
              <span>{multiSelectedGroupIds.size} selected</span>
              <button type="button" className="icon-button" title="Clear selection" aria-label="Clear selection" onClick={() => setMultiSelectedGroupIds(new Set())}><X size={13} /></button>
            </div>
          )}
        </aside>
        <div className="preview">
          {/* One merged bar for whichever phase is active (job-status vs.
              bulk-live-progress used to be two separately-boxed blocks,
              plus a third box below for the queue list — collapsing them
              into a single compact bar was specifically requested, since
              stacking all three ate a lot of the preview pane). */}
          {(job || bulkProgress || activeLiveRequest || pendingBulkRequests.length > 0) && (
            <div className="bulk-status-bar">
              <div className="bulk-status-top">
                <strong>
                  {bulkProgress
                    ? bulkProgress.label
                    : activeLiveRequest
                    ? geminiLiveState.connected ? "Generating via Gemini extension" : "Awaiting Gemini extension connection"
                    : job
                    ? `Bulk job: ${job.status}`
                    : "Bulk Generation queued"}
                </strong>
                <span>
                  {bulkProgress && bulkProgress.total > 0 && `${bulkProgress.current} / ${bulkProgress.total}`}
                  {!bulkProgress && activeLiveRequest && liveRequestProgress && `${liveRequestProgress.imported}/${liveRequestProgress.total} imported`}
                  {!bulkProgress && !activeLiveRequest && job && `${job.completedItems}/${job.totalItems} completed${job.failedItems ? ` · ${job.failedItems} failed` : ""}`}
                </span>
                {pendingBulkRequests.length > 0 && (
                  <div className="bulk-queue-popover-anchor">
                    <button type="button" className="bulk-status-queued-toggle" onClick={() => setBulkQueueExpanded((current) => !current)}>
                      +{pendingBulkRequests.length} queued {bulkQueueExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {bulkQueueExpanded && (
                      <BulkQueueMiniList pending={pendingBulkRequests} onCancel={(id) => void cancelQueuedRequest(id)} onReorder={(id, direction) => void reorderQueuedRequest(id, direction)} onClose={() => setBulkQueueExpanded(false)} />
                    )}
                  </div>
                )}
                <div className="bulk-status-actions">
                  {bulkProgress ? (
                    <>
                      {(promptPrepStatus === "running" || bulkPlanStatus === "running") && <button className="secondary" onClick={() => (bulkPlanStatus ? controlBulkPlan("pause") : controlPromptPreparation("pause"))}>Pause</button>}
                      {(promptPrepStatus === "paused" || bulkPlanStatus === "paused") && <button className="secondary" onClick={() => (bulkPlanStatus ? controlBulkPlan("resume") : controlPromptPreparation("resume"))}>Resume</button>}
                      <button className="secondary" onClick={() => (bulkPlanStatus !== null ? controlBulkPlan("stop") : controlPromptPreparation("stop"))}>Stop</button>
                    </>
                  ) : activeLiveRequest ? null : job && (
                    <>
                      {["queued", "running"].includes(job.status) && <button className="secondary" onClick={() => void controlJob("pause")}>Pause</button>}
                      {job.status === "paused" && <button className="secondary" onClick={() => void controlJob("resume")}>Resume</button>}
                      {job.status === "failed" && job.failedItems > 0 && <button className="secondary" onClick={() => void controlJob("resume")}>Retry {job.failedItems}</button>}
                      {["queued", "running", "paused"].includes(job.status) && <button className="secondary" onClick={() => setConfirmingStop(true)}>Stop</button>}
                    </>
                  )}
                </div>
              </div>
              {bulkProgress ? (
                bulkProgress.total > 0 ? <progress value={bulkProgress.current} max={bulkProgress.total} /> : <progress />
              ) : activeLiveRequest ? (
                liveRequestProgress && liveRequestProgress.total > 0
                  ? <progress value={liveRequestProgress.imported} max={liveRequestProgress.total} />
                  : <progress />
              ) : job ? (
                <progress value={job.completedItems + job.failedItems} max={job.totalItems} />
              ) : null}
            </div>
          )}
          {(() => {
            const active = singleQueue.filter((item) => ["queued", "running"].includes(item.status));
            if (!active.length) return null;
            const running = active.filter((item) => item.status === "running").length;
            const queued = active.length - running;
            return (
              <div className="bulk-status-bar single-queue-status-bar">
                <div className="bulk-status-top">
                  <strong>Single-still queue</strong>
                  <span>{running ? `${running} generating` : ""}{running && queued ? " · " : ""}{queued ? `${queued} queued` : ""}</span>
                </div>
              </div>
            );
          })()}
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
            <div className="version-nav"><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) >= imageRenders.length - 1} onClick={() => moveVersion(1)}><ChevronLeft size={16} />Older</button><strong>{(() => {
              // 1-based position within imageRenders (index 0 = newest), so the
              // newest version always reads as "N / N" — never greater than the
              // total, unlike the old raw `render.version` counter, which could
              // outrun the array length once older versions were pruned.
              const total = imageRenders.length;
              const index = imageRenders.findIndex((r) => r.id === selectedRenderId);
              return index >= 0 ? `Version ${total - index} / ${total}` : "No versions";
            })()}</strong><button disabled={imageRenders.findIndex((r) => r.id === selectedRenderId) <= 0} onClick={() => moveVersion(-1)}>Newer<ChevronRight size={16} /></button></div>
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
            <button role="tab" aria-selected={tab === "edit"} className={tab === "edit" ? "active" : ""} onClick={() => setTab("edit")}>Edit</button>
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
                <div className="directive-field">
                  <textarea className="production-copy" value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="Art style, rendering, color language, recurring subjects, visual consistency rules..." />
                  <button type="button" className="directive-clean-button" title="Clean up style directive — remove anything that belongs in Image Settings instead" aria-label="Clean up style directive" onClick={() => void cleanStyleDirective()} disabled={!systemPrompt.trim() || aiLoading}><Sparkles size={12} /></button>
                </div>
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
              {(() => {
                // Scoped to THIS still only — queuing one still no longer
                // blocks Generate for every other still (see generateRender).
                const selectedQueued = singleQueue.find((item) => item.groupId === selectedGroupId
                  && ["queued", "running"].includes(item.status));
                const submitting = generatingGroupId === selectedGroupId;
                const busy = submitting || Boolean(selectedQueued);
                return (
                  <button className="primary full generate-image-btn" onClick={() => void generateRender()} disabled={!selectedGroupId || !userPrompt.trim() || busy}>
                    {busy
                      ? <><LoaderCircle className="spin" size={14} />{selectedQueued?.status === "queued" ? "Queued…" : "Generating…"}</>
                      : "Generate Image"}
                  </button>
                );
              })()}
            </div>
          ) : tab === "settings" ? (
            <>
              <div className="panel-section-heading"><h3>Image settings</h3><small>Per still</small></div>
              <div className="setting-grid">
                <SettingSelect label="Aspect Ratio" value={imageSettings.aspectRatio} options={["16:9","9:16"]} onChange={(value) => updateImageSetting("aspectRatio", value)} />
                <SettingSelect label="Visualization Type" value={imageSettings.visualizationType} options={VISUALIZATION_TYPES} onChange={(value) => updateImageSetting("visualizationType", value)} />
              </div>
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
                {references.map((reference) => <div className="reference-item" key={reference.id}>{referenceUrl ? <img src={referenceUrl} alt="Visual reference" /> : <span>IMG</span>}<button title="Extract Style" onClick={() => void extractStyle(reference.id)} disabled={aiLoading}><Sparkles size={13} />Extract Style</button><div className="reference-item-actions"><button type="button" className="icon-button" aria-label="Choose which aspects Extract Style focuses on" title="Extract Style aspects" onClick={() => void openExtractStyleAspects()}><Settings size={13} /></button><button type="button" className="icon-button" onClick={() => void removeReference(reference.id)} aria-label={`Remove ${reference.originalName}`}><X size={13} /></button></div></div>)}
              </div>
            </>
          ) : (
            <div className="edit-panel">
              <h3>Edit existing image</h3>
              <p>Paint over the area you want changed, then describe the edit in the field below. The rest of the image will be preserved.</p>
              <button className="primary full" onClick={() => { clearMask(); setEditOpen(true); }} disabled={!selectedRenderId}>Edit</button>
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
          <div className="lightbox-toolbar"><strong>Edit</strong><button className={eraseMask && !editPanMode ? "active" : ""} onClick={() => { setEraseMask((current) => !current); setEditPanMode(false); }}>{eraseMask ? "Paint mask" : "Erase mask"}</button><button className={editPanMode ? "active" : ""} onClick={() => setEditPanMode((current) => !current)}>Pan</button><button onClick={() => setEditZoom((value) => Math.max(.5, value - .25))}><ZoomOut size={16} /></button><button onClick={() => { setEditZoom(1); setEditPan({ x: 0, y: 0 }); }}>Fit</button><button onClick={() => setEditZoom((value) => Math.min(4, value + .25))}><ZoomIn size={16} /></button><button onClick={clearMask}>Clear mask</button><button onClick={() => setEditOpen(false)}><X size={17} /></button></div>
          <div className="edit-body">
            <div className={editPanMode ? "mask-stage panning" : "mask-stage"} onPointerDown={(event) => { if (editPanMode) panStartRef.current = { x: event.clientX, y: event.clientY, originX: editPan.x, originY: editPan.y }; }} onPointerMove={(event) => { const start = panStartRef.current; if (editPanMode && start) setEditPan({ x: start.originX + event.clientX - start.x, y: start.originY + event.clientY - start.y }); }} onPointerUp={() => { panStartRef.current = null; }}>
              <div className={`mask-transform ${imageSettings.aspectRatio === "9:16" ? "portrait" : ""}`} style={{ transform: `translate(${editPan.x}px, ${editPan.y}px) scale(${editZoom})` }}>
                <img src={renderUrls[selectedRenderId]} alt="Source image for editing" />
                <canvas ref={maskCanvasRef} aria-label="Mask painting canvas — paint over areas to edit" width={imageSettings.aspectRatio === "9:16" ? 720 : 1280} height={imageSettings.aspectRatio === "9:16" ? 1280 : 720} onPointerDown={(event) => { if (editPanMode) return; paintingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); paintMask(event); }} onPointerMove={(event) => { if (!editPanMode) paintMask(event); }} onPointerUp={() => { paintingRef.current = false; }} />
              </div>
            </div>
            <aside>
              <p>Paint only the area you want changed. The rest of the image is preserved through visual context and strict edit rules applied alongside your mask and instruction.</p>
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
          <div className="modal-heading-row">
            <h2>Bulk Generation</h2>
            <div className="bulk-modal-heading-actions">
              <button type="button" className="bulk-global-settings-button" onClick={() => setBulkGlobalOpen(true)} aria-label="Global Settings" title="Global Settings"><Settings size={16} /></button>
              <button type="button" className="icon-button" aria-label="Close" onClick={() => setBulkOpen(false)}><X size={16} /></button>
            </div>
          </div>
          <div className="bulk-selection-summary">
            <span>{bulkSelection.size} of {stillCount} still{stillCount === 1 ? "" : "s"} selected across {stillSections.filter((section) => section.scene).length} scene{stillSections.filter((section) => section.scene).length === 1 ? "" : "s"}</span>
            <div>
              <button type="button" className="link-button" onClick={() => setBulkSelection(rememberBulkSelection(new Set(stillSections.flatMap((section) => section.groups).map((group) => group.group.id))))}>Select all</button>
              <button type="button" className="link-button" onClick={() => setBulkSelection(rememberBulkSelection(new Set()))}>Clear</button>
            </div>
          </div>
          <div className="bulk-scene-list">
            {stillSections.map((section, sectionIndex) => {
              const groupIds = section.groups.map((group) => group.group.id);
              const scene = section.scene;
              // Local bulkExpandedScenes state, not scene.expanded — see the
              // Bulk Generation panel's own collapse-state note above.
              const expanded = !scene || (bulkExpandedScenes[scene.id] ?? true);
              return (
                <SceneBulkRow
                  key={scene?.id ?? `no-scene-${sectionIndex}`}
                  scene={scene}
                  groups={section.groups}
                  selection={bulkSelection}
                  stillSettings={bulkStillSettings}
                  aspectRatio={imageSettings.aspectRatio}
                  renderUrls={renderUrls}
                  onToggleScene={() => toggleBulkScene(groupIds)}
                  onToggleStill={toggleBulkStill}
                  expanded={expanded}
                  onToggleExpanded={scene ? () => toggleBulkSceneExpanded(scene.id) : undefined}
                  override={scene ? bulkSceneSettings.find((item) => item.sceneId === scene.id) ?? null : null}
                  overrideOpen={Boolean(scene) && bulkOverrideOpenSceneId === scene?.id}
                  onToggleOverrideOpen={() => setBulkOverrideOpenSceneId((current) => (scene && current !== scene.id ? scene.id : null))}
                  onSaveOverride={(patch) => scene && void saveSceneOverride(scene.id, patch)}
                  rosterCharacters={rosterCharacters}
                  rosterLocations={rosterLocations}
                  castAssignment={scene ? sceneCastAssignments.find((item) => item.sceneId === scene.id) ?? null : null}
                  onSaveCast={(characterIds, locationId) => scene && void saveCastAssignment(scene.id, characterIds, locationId)}
                  onOpenVisualDirection={() => scene && setSceneDialModal({ sceneId: scene.id, kind: "visual" })}
                  onOpenDiversity={() => scene && setSceneDialModal({ sceneId: scene.id, kind: "diversity" })}
                />
              );
            })}
          </div>
          {bulkGenerationMode === "browser-live" && !geminiLiveState.connected && (
            <p style={{fontSize:"11px",color:"#c77a26",margin:"4px 0 0",textAlign:"center"}}>Not connected — open the Gemini Chrome extension and enable Live Connection first.</p>
          )}
          <button className="primary full" style={{marginTop:"10px"}} onClick={requestEnqueueBulkGeneration} disabled={!orderedBulkSelection.length || !systemPrompt.trim()}>
            <WandSparkles size={16} />{`Generate Selected (${bulkSelection.size})`}
          </button>
          {!systemPrompt.trim() ? (
            <p style={{fontSize:"11px",color:"#c77a26",margin:"6px 0 0",textAlign:"center"}}>Write a style directive in Global Settings above, or use Extract Style on a reference image, before generating.</p>
          ) : bulkGenerationMode === "browser-live" ? (
            <p style={{fontSize:"11px",color:"var(--muted)",margin:"6px 0 0",textAlign:"center"}}>Plans the selected stills via Claude CLI, then drives the connected Gemini Chrome extension one still at a time — images appear here as they finish.</p>
          ) : (
            <p style={{fontSize:"11px",color:"var(--muted)",margin:"6px 0 0",textAlign:"center"}}>Plans and generates the selected stills in one pausable run — no separate review step. {bulkQueue.some((request) => !["completed", "failed", "cancelled"].includes(request.status)) && "A generation is already in progress — this will queue and start once it's this run's turn."}</p>
          )}
        </div>
      </div>}

      {bulkGlobalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setBulkGlobalOpen(false)}>
        <div className="modal bulk-modal" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal-heading-row"><h2>Global Bulk Settings</h2><button type="button" className="icon-button" aria-label="Close" onClick={() => setBulkGlobalOpen(false)}><X size={16} /></button></div>

          <div className="bulk-modal-group">Style Directive<span className="required-badge">Required</span></div>
          <p style={{fontSize:"12px",color:"var(--text-muted)",margin:"0 0 8px"}}>Describe overall cinematography and visual language. Avoid scene-specific details — the AI will handle those per still.</p>
          <div className="directive-field">
            <textarea className={`bulk-directive${systemPrompt.trim() ? "" : " needs-attention"}`} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="e.g. Cinematic documentary style, shallow depth of field, warm color grade, soft natural lighting…" rows={4} />
            <button type="button" className="directive-clean-button" title="Clean up style directive — remove anything that belongs in Image Settings instead" aria-label="Clean up style directive" onClick={() => void cleanStyleDirective()} disabled={!systemPrompt.trim() || aiLoading}><Sparkles size={12} /></button>
          </div>

          <div className="bulk-modal-group">Reference Image</div>
          <p style={{fontSize:"12px",color:"var(--text-muted)",margin:"0 0 8px"}}>Upload a reference to extract visual style and populate the directive automatically.</p>
          <div className="reference-list bulk-ref-list">
            {references.map((reference) => (
              <div className="reference-item" key={reference.id}>
                {referenceUrl ? <img src={referenceUrl} alt="Visual reference" /> : <span>IMG</span>}
                <button onClick={() => void extractStyle(reference.id)} disabled={aiLoading}><Sparkles size={13} />Extract Style</button>
                <div className="reference-item-actions">
                  <button type="button" className="icon-button" aria-label="Choose which aspects Extract Style focuses on" title="Extract Style aspects" onClick={() => void openExtractStyleAspects()}><Settings size={13} /></button>
                  <button type="button" className="icon-button" onClick={() => void removeReference(reference.id)} aria-label={`Remove ${reference.originalName}`}><X size={13} /></button>
                </div>
              </div>
            ))}
            {!references.length && <button className="secondary" onClick={() => void importReference()}><Plus size={14} />Upload reference image</button>}
          </div>

          <div className="bulk-modal-group">Creative Instructions</div>
          <p style={{fontSize:"12px",color:"var(--muted)",margin:"0 0 8px",lineHeight:"1.55"}}>Hard rules applied to <strong>every</strong> still (unless a scene overrides them below in the main panel). Positive rules (always include X, use Y) are woven into the scene description. Negative rules (avoid X, no Y) are extracted and appended to the prompt as <code>[Avoid: ...]</code>.</p>
          <textarea className="bulk-directive" value={bulkInstruction} onChange={(e) => setBulkInstruction(e.target.value)} placeholder="e.g. Always include the orange cat as the main character. Show visible emotions and varied body language. Avoid showing text, labels, or close-ups on faces." rows={4} />

          <div className="bulk-modal-group">Cast &amp; Locations</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{rosterCharacters.length} character{rosterCharacters.length === 1 ? "" : "s"} · {rosterLocations.length} location{rosterLocations.length === 1 ? "" : "s"}</span>
            <button type="button" className="secondary" onClick={() => setRosterModalOpen(true)}><Users size={12} />Manage roster</button>
          </div>

          <div className="bulk-modal-group">Visual Direction</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{[bulkGlobalVisualSettings.dials.visualInterpretation, bulkGlobalVisualSettings.dials.visualMetaphor, bulkGlobalVisualSettings.dials.cinematicIntensity, bulkGlobalVisualSettings.dials.promptCreativity, bulkGlobalVisualSettings.dials.mood].filter((value) => value !== null).length} of 5 customized</span>
            <button type="button" className="secondary" onClick={() => setVisualDirectionModalOpen(true)}>Manage Visual Direction</button>
          </div>

          <div className="bulk-modal-group">Diversity &amp; Consistency</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{[bulkGlobalVisualSettings.dials.diversityCamera, bulkGlobalVisualSettings.dials.diversityComposition, bulkGlobalVisualSettings.dials.diversityShotType, bulkGlobalVisualSettings.dials.consistencyCharacter, bulkGlobalVisualSettings.dials.consistencyLocation, bulkGlobalVisualSettings.dials.consistencyStyle].filter((value) => value !== null).length} of 6 customized</span>
            <button type="button" className="secondary" onClick={() => setDiversityModalOpen(true)}>Manage Diversity &amp; Consistency</button>
          </div>

          <div className="bulk-modal-group">Visualization Types</div>
          <div className="bulk-scene-reference roster-launcher">
            <span>{bulkGlobalVisualSettings.visualizationHardRule ? `Restricted to ${bulkGlobalVisualSettings.visualizationTypes.length} type${bulkGlobalVisualSettings.visualizationTypes.length === 1 ? "" : "s"}` : "Let AI decide"}</span>
            <button type="button" className="secondary" onClick={() => setVisualizationTypesModalOpen(true)}>Manage Visualization Types</button>
          </div>

          <button className="primary full" style={{marginTop:"18px"}} onClick={() => setBulkGlobalOpen(false)}>Done</button>
        </div>
      </div>}

      {visualDirectionModalOpen && (
        <VisualDirectionModal
          dials={bulkGlobalVisualSettings.dials}
          onChange={updateGlobalDial}
          onClose={() => setVisualDirectionModalOpen(false)}
        />
      )}

      {diversityModalOpen && (
        <DiversityConsistencyModal
          dials={bulkGlobalVisualSettings.dials}
          onChange={updateGlobalDial}
          onClose={() => setDiversityModalOpen(false)}
        />
      )}

      {visualizationTypesModalOpen && (
        <VisualizationTypesModal
          types={bulkGlobalVisualSettings.visualizationTypes}
          hardRule={bulkGlobalVisualSettings.visualizationHardRule}
          onChange={(patch) => void saveGlobalVisualSettings(patch)}
          onClose={() => setVisualizationTypesModalOpen(false)}
        />
      )}

      {sceneDialModal && (() => {
        const sceneId = sceneDialModal.sceneId;
        const dials = bulkSceneSettings.find((item) => item.sceneId === sceneId)?.dials ?? emptyBulkVisualDials();
        const onChange = (patch: Partial<BulkVisualDialsRecord>) => void saveSceneOverride(sceneId, { dials: { ...dials, ...patch } });
        return sceneDialModal.kind === "visual" ? (
          <SceneVisualDirectionModal
            dials={dials}
            globalDials={bulkGlobalVisualSettings.dials}
            globalMood={bulkGlobalVisualSettings.dials.mood}
            onChange={onChange}
            onClose={() => setSceneDialModal(null)}
          />
        ) : (
          <SceneDiversityConsistencyModal
            dials={dials}
            globalDials={bulkGlobalVisualSettings.dials}
            onChange={onChange}
            onClose={() => setSceneDialModal(null)}
          />
        );
      })()}

      {rosterModalOpen && (
        <RosterModal
          characters={rosterCharacters}
          locations={rosterLocations}
          onClose={() => setRosterModalOpen(false)}
          onAddCharacter={() => void addRosterCharacter()}
          onAddLocation={() => void addRosterLocation()}
          onRenameCharacter={(id, name) => void renameRosterCharacter(id, name)}
          onRenameLocation={(id, name) => void renameRosterLocation(id, name)}
          onRemoveCharacter={(id) => void removeRosterCharacter(id)}
          onRemoveLocation={(id) => void removeRosterLocation(id)}
          onImportCharacterReference={(id) => void importRosterCharacterReference(id)}
          onImportLocationReference={(id) => void importRosterLocationReference(id)}
          onSuggestCast={() => void suggestCast(stillSections.map((section) => section.scene?.id).filter((id): id is string => Boolean(id)))}
          suggesting={suggestingCast}
        />
      )}

      {extractStyleAspectsOpen && selectedAspectKeys && (
        <ExtractStyleAspectsModal
          aspects={extractStyleAspects}
          selectedKeys={selectedAspectKeys}
          onToggle={(key) => void toggleExtractStyleAspect(key)}
          onSelectAll={() => void setAllExtractStyleAspects(true)}
          onSelectNone={() => void setAllExtractStyleAspects(false)}
          onClose={() => setExtractStyleAspectsOpen(false)}
        />
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
    exportState,
    exportCollapsed,
    setStage,
    setExportCollapsed,
    geminiLiveState,
  } = useAppStore();
  const [startupNotice, setStartupNotice] = useState<string | null>(null);
  // Subscribed once, for the app's whole lifetime — NOT inside TimelineView,
  // which the stage router fully unmounts on every tab switch. The export
  // itself keeps running in the backend regardless of what's mounted; this
  // is what lets progress keep updating (and the mini badge below show it)
  // no matter which tab the user is actually looking at. See app-store.ts's
  // ExportState doc comment for the full rationale.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<{ videoId: string; exportId: string; percent: number; stage: string; detail: string }>(
          "export-progress",
          ({ payload }) => {
            useAppStore.getState().updateExportProgress(payload.videoId, payload.exportId, payload.percent, payload.stage, payload.detail);
          },
        );
      } catch {
        // Browser preview has no native event bridge.
      }
    })();
    return () => { unlisten?.(); };
  }, []);
  // Same idiom as the export-progress listener above — subscribed once,
  // for the app's whole lifetime, feeding the Zustand store (not component
  // state) so any component, mounted or not, can react. See
  // GeminiLiveState's doc comment in app-store.ts.
  useEffect(() => {
    let unlistenConnection: (() => void) | undefined;
    let unlistenImported: (() => void) | undefined;
    (async () => {
      try {
        unlistenConnection = await listen<{ connected: boolean }>(
          "gemini-extension-connection-changed",
          ({ payload }) => useAppStore.getState().setGeminiLiveConnected(payload.connected),
        );
        unlistenImported = await listen<{ videoId: string; groupId: string; renderId: string; isFinal: boolean }>(
          "gemini-extension-render-imported",
          ({ payload }) => {
            useAppStore.getState().noteGeminiRenderImported(payload.videoId);
            // Fires regardless of which tab/video is currently active — the
            // per-video live-refresh (ImagesView) only fires when it's
            // mounted and looking at the matching video; this toast is what
            // surfaces the same event everywhere else.
            useAppStore.getState().addToast("An image from the Gemini Chrome extension is ready", "success");
          },
        );
      } catch {
        // Browser preview has no native event bridge.
      }
    })();
    return () => { unlistenConnection?.(); unlistenImported?.(); };
  }, []);
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
      <main><Header />{startupNotice && <div className="startup-notice">{startupNotice}<button onClick={() => setStartupNotice(null)}>Dismiss</button></div>}<UpdateBanner />{stage === "home" && <HomeView />}{["inputs", "visual-plan"].includes(stage) && <ProductionView />}{stage === "images" && <ImagesView />}{stage === "animate" && <AnimateView />}{stage === "timeline" && <TimelineView />}</main>
      {exportState && (stage !== "timeline" || exportCollapsed) && (
        <ExportMiniBadge
          exportState={exportState}
          onExpand={() => { setStage("timeline"); setExportCollapsed(false); }}
        />
      )}
      {stage !== "home" && (
        <div
          className={`gemini-live-badge ${geminiLiveState.connected ? "gemini-live-badge-connected" : "gemini-live-badge-disconnected"}`}
          title={geminiLiveState.connected ? "Gemini Chrome extension connected" : "Gemini Chrome extension not connected — open its popup and enable Live Connection"}
        >
          {geminiLiveState.connected ? "🟢 Gemini extension connected" : "⚪ Gemini extension not connected"}
        </div>
      )}
      <ToastDisplay />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { getCachedData, resolveAssetUrl, setCachedData } from "../infrastructure/media-cache";
import { projectsClient, type CaptionSetRecord, type ImageWorkspaceRecord, type TimelineRecord } from "../infrastructure/projects-client";

/** Loads the workspace/timeline/captions for the active video (stale-while-
 * revalidate against the local cache), and owns every mutation's local undo
 * history — `refresh` wraps a backend call, snapshots the timeline before it
 * for undo, and `undo`/`redo` restore a prior snapshot via the backend's own
 * `restoreTimelineSnapshot`, so history survives exactly as long as the
 * session (a full page reload starts a fresh stack, same as before this
 * refactor). */
export function useTimelineData(
  activeVideoId: string | null,
  /** Fires synchronously when `activeVideoId` changes, before the async
   * load starts — lets the caller clear its own selection state
   * (`selectedClip`, `activeTool`, etc.) for the new video. */
  onVideoChange?: () => void,
) {
  const [timeline, setTimeline] = useState<TimelineRecord | null>(null);
  const [workspace, setWorkspace] = useState<ImageWorkspaceRecord | null>(null);
  const [captionSet, setCaptionSet] = useState<CaptionSetRecord | null>(null);
  const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  // Mirrors undoStackRef/redoStackRef's non-emptiness as real state (rather
  // than reading ref.current.length at render time) so canUndo/canRedo
  // update the UI correctly on every push/pop.
  const [historyAvailability, setHistoryAvailability] = useState({ canUndo: false, canRedo: false });

  const undoStackRef = useRef<TimelineRecord[]>([]);
  const redoStackRef = useRef<TimelineRecord[]>([]);
  function syncHistoryAvailability() {
    setHistoryAvailability({ canUndo: undoStackRef.current.length > 0, canRedo: redoStackRef.current.length > 0 });
  }

  // Mirrors `timeline` state, updated SYNCHRONOUSLY at every write (see
  // setTimelineAndRef below) rather than via a useEffect reacting to state —
  // an effect-based mirror still has a one-tick lag: two `refresh()` calls
  // fired back-to-back (e.g. drag-resizing one clip then immediately
  // dragging a second) could both read `before` from the closed-over
  // `timeline` state before either update had flowed through a re-render,
  // corrupting the undo stack with a duplicate/skipped entry. Reading from
  // this ref instead guarantees a second, near-simultaneous `refresh()` call
  // always sees the first call's result, even before React has re-rendered.
  const timelineRef = useRef<TimelineRecord | null>(null);
  function setTimelineAndRef(value: TimelineRecord | null | ((previous: TimelineRecord | null) => TimelineRecord | null)) {
    setTimeline((previous) => {
      const next = typeof value === "function"
        ? (value as (previous: TimelineRecord | null) => TimelineRecord | null)(previous)
        : value;
      timelineRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    if (!activeVideoId) return;
    let cancelled = false;
    setError(null);
    onVideoChange?.();
    undoStackRef.current = [];
    redoStackRef.current = [];
    timelineRef.current = null;
    setHistoryAvailability({ canUndo: false, canRedo: false });

    // Stale-while-revalidate: show whatever we already have for this video
    // instantly (no spinner flash on every tab switch), then refresh quietly.
    const cachedWorkspace = getCachedData<ImageWorkspaceRecord>(`tl-workspace:${activeVideoId}`);
    const cachedTimeline = getCachedData<TimelineRecord>(`tl-timeline:${activeVideoId}`);
    const cachedCaptions = getCachedData<CaptionSetRecord | null>(`tl-captions:${activeVideoId}`);
    if (cachedWorkspace) setWorkspace(cachedWorkspace);
    if (cachedTimeline) setTimelineAndRef(cachedTimeline);
    if (cachedCaptions !== undefined) setCaptionSet(cachedCaptions);
    setLoading(!cachedWorkspace || !cachedTimeline);

    (async () => {
      try {
        // getImageWorkspace requires a generated visual plan and throws hard
        // if there isn't one (e.g. a raw "Import video" project, which never
        // has one) — kept separate from the Promise.all below so that
        // failure can't take the real timeline/narration/captions data down
        // with it. Editor features that need workspace (jump-to-still,
        // Generated grid) just see an empty one; everything else loads fine.
        const [loadedWorkspace, inputs] = await Promise.all([
          projectsClient.getImageWorkspace(activeVideoId).catch(() => null),
          projectsClient.getVideoInputs(activeVideoId),
        ]);
        if (cancelled) return;
        setCachedData(`tl-workspace:${activeVideoId}`, loadedWorkspace);
        setWorkspace(loadedWorkspace);
        if (inputs.audio) void resolveAssetUrl(inputs.audio.id).then((url) => { if (!cancelled) setAudioDataUrl(url); });
        try {
          const captions = await projectsClient.getCaptions(activeVideoId);
          if (!cancelled) {
            setCachedData(`tl-captions:${activeVideoId}`, captions);
            setCaptionSet(captions);
          }
        } catch {
          if (!cancelled) {
            setCachedData<CaptionSetRecord | null>(`tl-captions:${activeVideoId}`, null);
            setCaptionSet(null);
          }
        }
        let loadedTimeline: TimelineRecord;
        try {
          loadedTimeline = await projectsClient.getTimeline(activeVideoId);
        } catch {
          loadedTimeline = await projectsClient.populateTimelineFromSources(activeVideoId);
        }
        if (!cancelled) {
          setCachedData(`tl-timeline:${activeVideoId}`, loadedTimeline);
          setTimelineAndRef(loadedTimeline);
        }
      } catch (caught) {
        if (!cancelled) setError(String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoId]);

  /** `skipHistory` is for mutations that shouldn't clutter undo — zoom/fit
   * changes (fired on every wheel tick / slider drag) and the undo/redo
   * restore itself (which would otherwise re-push the state it's replacing). */
  async function refresh(promise: Promise<TimelineRecord>, options?: { skipHistory?: boolean }) {
    // Read from the ref, not the `timeline` state closed over when `refresh`
    // was called — see timelineRef's own comment on why.
    const before = timelineRef.current;
    setSavingCount((count) => count + 1);
    try {
      const next = await promise;
      if (activeVideoId) setCachedData(`tl-timeline:${activeVideoId}`, next);
      setTimelineAndRef(next);
      if (before && !options?.skipHistory) {
        undoStackRef.current.push(before);
        if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        redoStackRef.current = [];
        syncHistoryAvailability();
      }
    } catch (caught) {
      setError(String(caught));
      throw caught;
    } finally {
      setSavingCount((count) => count - 1);
    }
  }

  async function undo() {
    const current = timelineRef.current;
    if (!activeVideoId || !current || !undoStackRef.current.length) return;
    const previous = undoStackRef.current.pop()!;
    redoStackRef.current.push(current);
    if (redoStackRef.current.length > 50) redoStackRef.current.shift();
    await refresh(projectsClient.restoreTimelineSnapshot(activeVideoId, previous), { skipHistory: true });
    syncHistoryAvailability();
  }

  async function redo() {
    const current = timelineRef.current;
    if (!activeVideoId || !current || !redoStackRef.current.length) return;
    const next = redoStackRef.current.pop()!;
    undoStackRef.current.push(current);
    if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    await refresh(projectsClient.restoreTimelineSnapshot(activeVideoId, next), { skipHistory: true });
    syncHistoryAvailability();
  }

  return {
    timeline, setTimeline: setTimelineAndRef,
    workspace,
    captionSet, setCaptionSet,
    audioDataUrl,
    loading,
    error, setError,
    savingCount,
    canUndo: historyAvailability.canUndo,
    canRedo: historyAvailability.canRedo,
    refresh,
    undo,
    redo,
  };
}

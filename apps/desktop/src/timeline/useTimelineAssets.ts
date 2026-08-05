import { useEffect, useRef, useState } from "react";
import { resolveRenderUrl, resolveVideoAssetUrl } from "../infrastructure/media-cache";
import { projectsClient, type ImageWorkspaceRecord, type TimelineRecord } from "../infrastructure/projects-client";
import type { AspectRatio } from "./Toolbar";

function canvasSizeForAspectRatio(aspectRatio: AspectRatio): { width: number; height: number } {
  return aspectRatio === "9:16" ? { width: 540, height: 960 } : { width: 960, height: 540 };
}

/** Resolves and caches every asset URL/element the preview canvas needs to
 * draw a frame — still-image render URLs, generated-clip video URLs,
 * detected zoom-subject points, and the actual `<img>`/`<video>` elements
 * (loaded once, reused across every draw call). Also owns the preview
 * canvas's pixel size, driven by the project's aspect-ratio setting rather
 * than any individual still's natural size — stills that don't match get
 * cover-cropped at draw time (see drawStillClipContent), same as export. */
export function useTimelineAssets(
  activeVideoId: string | null,
  timeline: TimelineRecord | null,
  workspace: ImageWorkspaceRecord | null,
  aspectRatio: AspectRatio,
  /** Invoked once a lazily-loaded image finishes decoding — lets the caller
   * re-draw the current frame without this hook needing to know anything
   * about the RAF loop. */
  onAssetReady?: () => void,
) {
  const [renderUrls, setRenderUrls] = useState<Record<string, string>>({});
  const [videoAssetUrls, setVideoAssetUrls] = useState<Record<string, string>>({});
  const [subjectByRender, setSubjectByRender] = useState<Record<string, { x: number; y: number }>>({});
  // A pure derivation of the aspect-ratio setting, not independent state.
  const canvasSize = canvasSizeForAspectRatio(aspectRatio);

  const imageElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const onAssetReadyRef = useRef(onAssetReady);
  useEffect(() => {
    onAssetReadyRef.current = onAssetReady;
  });

  // Every still's latest render, so the Media Library panel's "Generated"
  // grid has thumbnails even for stills not yet placed on the timeline.
  useEffect(() => {
    const ids = (workspace?.groups ?? []).map((group) => group.imageRenders[0]?.id).filter(Boolean) as string[];
    void Promise.all(ids.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [workspace, renderUrls]);

  useEffect(() => {
    const renderIds = (timeline?.clips ?? []).map((clip) => clip.renderId).filter(Boolean) as string[];
    void Promise.all(renderIds.filter((id) => !renderUrls[id]).map(async (id) => {
      const url = await resolveRenderUrl(id);
      setRenderUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [timeline, renderUrls]);

  useEffect(() => {
    if (!activeVideoId) return;
    const subjectRenderIds = (timeline?.clips ?? [])
      .filter((clip) => clip.motionPreset === "zoom-in-subject" || clip.motionPreset === "zoom-out-subject")
      .map((clip) => clip.renderId)
      .filter(Boolean) as string[];
    void Promise.all(subjectRenderIds.filter((id) => !subjectByRender[id]).map(async (id) => {
      try {
        const [x, y] = await projectsClient.detectRenderSubject(activeVideoId, id);
        setSubjectByRender((current) => ({ ...current, [id]: { x, y } }));
      } catch {
        // Leave unresolved — applyMotion falls back to frame-center until it succeeds.
      }
    }));
  }, [timeline, activeVideoId, subjectByRender]);

  useEffect(() => {
    const videoAssetIds = (timeline?.clips ?? []).map((clip) => clip.videoAssetId).filter(Boolean) as string[];
    void Promise.all(videoAssetIds.filter((id) => !videoAssetUrls[id]).map(async (id) => {
      const url = await resolveVideoAssetUrl(id);
      setVideoAssetUrls((current) => ({ ...current, [id]: url }));
    }));
  }, [timeline, videoAssetUrls]);

  function getOrLoadImage(url: string): HTMLImageElement | null {
    const cache = imageElsRef.current;
    let img = cache.get(url);
    if (!img) {
      img = new Image();
      img.onload = () => {
        onAssetReadyRef.current?.();
      };
      img.src = url;
      cache.set(url, img);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  function getOrLoadVideo(url: string): HTMLVideoElement {
    const cache = videoElsRef.current;
    let video = cache.get(url);
    if (!video) {
      video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";
      video.src = url;
      cache.set(url, video);
    }
    return video;
  }

  function getImageByRenderId(renderId: string): HTMLImageElement | null {
    const url = renderUrls[renderId];
    return url ? getOrLoadImage(url) : null;
  }

  function getSubjectByRenderId(renderId: string): { x: number; y: number } | undefined {
    return subjectByRender[renderId];
  }

  return {
    renderUrls,
    videoAssetUrls,
    subjectByRender,
    canvasSize,
    getOrLoadImage,
    getOrLoadVideo,
    getImageByRenderId,
    getSubjectByRenderId,
  };
}

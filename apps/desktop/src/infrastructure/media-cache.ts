import { convertFileSrc } from "@tauri-apps/api/core";
import { projectsClient } from "./projects-client";

// File paths never change for a given render/asset id, so these resolved
// asset:// URLs are safe to cache for the lifetime of the app — this avoids
// re-fetching the same thumbnail/audio path every time a tab is revisited.
const renderUrlCache = new Map<string, Promise<string>>();
const assetUrlCache = new Map<string, Promise<string>>();
const videoAssetUrlCache = new Map<string, Promise<string>>();

export function resolveRenderUrl(renderId: string): Promise<string> {
  let cached = renderUrlCache.get(renderId);
  if (!cached) {
    cached = projectsClient.getRenderFilePath(renderId).then((path) => (path ? convertFileSrc(path) : ""));
    renderUrlCache.set(renderId, cached);
  }
  return cached;
}

export function resolveAssetUrl(assetId: string): Promise<string> {
  let cached = assetUrlCache.get(assetId);
  if (!cached) {
    cached = projectsClient.getAssetFilePath(assetId).then((path) => (path ? convertFileSrc(path) : ""));
    assetUrlCache.set(assetId, cached);
  }
  return cached;
}

// Every retime creates a new video_assets row/version (never mutates a file
// in place), so a resolved video-asset id is just as safe to cache forever
// as a render id — a stale cache entry can never point at superseded content.
export function resolveVideoAssetUrl(videoAssetId: string): Promise<string> {
  let cached = videoAssetUrlCache.get(videoAssetId);
  if (!cached) {
    cached = projectsClient.getVideoAssetFilePath(videoAssetId).then((path) => (path ? convertFileSrc(path) : ""));
    videoAssetUrlCache.set(videoAssetId, cached);
  }
  return cached;
}

// Lightweight stale-while-revalidate store for per-video view data (image
// workspace, timeline, captions) so switching tabs shows the last-known data
// instantly instead of a loading spinner, while a fresh copy loads in the background.
const dataCache = new Map<string, unknown>();

export function getCachedData<T>(key: string): T | undefined {
  return dataCache.get(key) as T | undefined;
}

export function setCachedData<T>(key: string, value: T): void {
  dataCache.set(key, value);
}

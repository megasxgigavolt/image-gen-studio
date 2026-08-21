import { convertFileSrc } from "@tauri-apps/api/core";
import { projectsClient } from "./projects-client";

// File paths never change for a given render/asset id, so these resolved
// asset:// URLs are safe to cache for the lifetime of the app — this avoids
// re-fetching the same thumbnail/audio path every time a tab is revisited.
const renderUrlCache = new Map<string, Promise<string>>();
const assetUrlCache = new Map<string, Promise<string>>();
const videoAssetUrlCache = new Map<string, Promise<string>>();
const mediaLibraryAssetUrlCache = new Map<string, Promise<string>>();

/** Wraps a cache-populating lookup so a REJECTED promise never sits in the
 * cache permanently. Without this, a single transient failure (e.g. a
 * request that raced ahead of something not fully committed yet) poisoned
 * that id for the rest of the app session — every future caller got back
 * the same dead rejection instead of a fresh retry, which read as "this
 * specific image is stuck broken forever" (recoverable only by chance,
 * e.g. selecting a different, not-yet-cached id that happened to resolve
 * cleanly). On failure the entry is evicted so the very next call retries
 * from scratch instead of replaying the same rejection. */
function cachedOrRetry(cache: Map<string, Promise<string>>, key: string, load: () => Promise<string>): Promise<string> {
  let cached = cache.get(key);
  if (!cached) {
    cached = load().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, cached);
  }
  return cached;
}

export function resolveRenderUrl(renderId: string): Promise<string> {
  return cachedOrRetry(renderUrlCache, renderId, () =>
    projectsClient.getRenderFilePath(renderId).then((path) => (path ? convertFileSrc(path) : "")));
}

export function resolveAssetUrl(assetId: string): Promise<string> {
  return cachedOrRetry(assetUrlCache, assetId, () =>
    projectsClient.getAssetFilePath(assetId).then((path) => (path ? convertFileSrc(path) : "")));
}

// Every retime creates a new video_assets row/version (never mutates a file
// in place), so a resolved video-asset id is just as safe to cache forever
// as a render id — a stale cache entry can never point at superseded content.
export function resolveVideoAssetUrl(videoAssetId: string): Promise<string> {
  return cachedOrRetry(videoAssetUrlCache, videoAssetId, () =>
    projectsClient.getVideoAssetFilePath(videoAssetId).then((path) => (path ? convertFileSrc(path) : "")));
}

// Media library imports are copied into an immutable per-video library
// folder and never rewritten in place, so a resolved id is safe to cache
// forever — same reasoning as resolveVideoAssetUrl above.
export function resolveMediaLibraryAssetUrl(assetId: string): Promise<string> {
  return cachedOrRetry(mediaLibraryAssetUrlCache, assetId, () =>
    projectsClient.getMediaLibraryAssetFilePath(assetId).then((path) => (path ? convertFileSrc(path) : "")));
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

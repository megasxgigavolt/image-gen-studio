import { invoke } from "@tauri-apps/api/core";
import type { AppStage } from "../store/app-store";

export type ChannelRecord = {
  id: string;
  name: string;
  description: string | null;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VideoRecord = {
  id: string;
  channelId: string;
  title: string;
  stage: AppStage;
  progress: number;
  createdAt: string;
  updatedAt: string;
};

export type ResumeRecord = {
  channelId: string | null;
  videoId: string | null;
  stage: AppStage;
  updatedAt: string;
};

type BrowserData = {
  channels: ChannelRecord[];
  videos: VideoRecord[];
  trashedChannels?: ChannelRecord[];
  trashedVideos?: VideoRecord[];
  resume: ResumeRecord | null;
};

const STORAGE_KEY = "auto-gen-studio.dev-projects";
const isTauri = () => "__TAURI_INTERNALS__" in window;
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function readBrowserData(): BrowserData {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return JSON.parse(stored) as BrowserData;
  return { channels: [], videos: [], trashedChannels: [], trashedVideos: [], resume: null };
}

function writeBrowserData(data: BrowserData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export const projectsClient = {
  async listChannels(includeTrashed = false): Promise<ChannelRecord[]> {
    if (isTauri()) return invoke("list_channels", { includeTrashed });
    const data = readBrowserData();
    return includeTrashed ? data.trashedChannels ?? [] : data.channels;
  },
  async createChannel(name: string, description?: string): Promise<ChannelRecord> {
    if (isTauri()) return invoke("create_channel", { name, description });
    const data = readBrowserData();
    const channel: ChannelRecord = {
      id: id(), name, description: description || null, videoCount: 0,
      createdAt: now(), updatedAt: now(),
    };
    data.channels.unshift(channel);
    writeBrowserData(data);
    return channel;
  },
  async listVideos(channelId: string, includeTrashed = false): Promise<VideoRecord[]> {
    if (isTauri()) return invoke("list_videos", { channelId, includeTrashed });
    const data = readBrowserData();
    const source = includeTrashed ? data.trashedVideos ?? [] : data.videos;
    return source.filter((video) => video.channelId === channelId);
  },
  async createVideo(channelId: string, title: string): Promise<VideoRecord> {
    if (isTauri()) return invoke("create_video", { channelId, title });
    const data = readBrowserData();
    const video: VideoRecord = {
      id: id(), channelId, title, stage: "inputs", progress: 0,
      createdAt: now(), updatedAt: now(),
    };
    data.videos.unshift(video);
    const channel = data.channels.find((candidate) => candidate.id === channelId);
    if (channel) channel.videoCount += 1;
    writeBrowserData(data);
    return video;
  },
  async getResume(): Promise<ResumeRecord | null> {
    if (isTauri()) return invoke("get_resume_state");
    return readBrowserData().resume;
  },
  async setResume(channelId: string, videoId: string, stage: AppStage) {
    if (isTauri()) {
      return invoke<ResumeRecord>("set_resume_state", { channelId, videoId, stage });
    }
    const data = readBrowserData();
    data.resume = { channelId, videoId, stage, updatedAt: now() };
    const video = data.videos.find((candidate) => candidate.id === videoId);
    if (video) {
      video.stage = stage;
      video.updatedAt = now();
    }
    writeBrowserData(data);
    return data.resume;
  },
  async trashChannel(channelId: string) {
    if (isTauri()) return invoke<void>("trash_channel", { id: channelId });
    const data = readBrowserData();
    const channel = data.channels.find((candidate) => candidate.id === channelId);
    if (channel) (data.trashedChannels ??= []).push(channel);
    data.channels = data.channels.filter((candidate) => candidate.id !== channelId);
    writeBrowserData(data);
  },
  async trashVideo(videoId: string) {
    if (isTauri()) return invoke<void>("trash_video", { id: videoId });
    const data = readBrowserData();
    const video = data.videos.find((candidate) => candidate.id === videoId);
    if (video) (data.trashedVideos ??= []).push(video);
    data.videos = data.videos.filter((candidate) => candidate.id !== videoId);
    const channel = data.channels.find((candidate) => candidate.id === video?.channelId);
    if (channel) channel.videoCount = Math.max(0, channel.videoCount - 1);
    writeBrowserData(data);
  },
  async restoreChannel(channelId: string) {
    if (isTauri()) return invoke<void>("restore_channel", { id: channelId });
    const data = readBrowserData();
    const channel = data.trashedChannels?.find((candidate) => candidate.id === channelId);
    if (channel) data.channels.unshift(channel);
    data.trashedChannels = data.trashedChannels?.filter((candidate) => candidate.id !== channelId);
    writeBrowserData(data);
  },
  async restoreVideo(videoId: string) {
    if (isTauri()) return invoke<void>("restore_video", { id: videoId });
    const data = readBrowserData();
    const video = data.trashedVideos?.find((candidate) => candidate.id === videoId);
    if (video) data.videos.unshift(video);
    data.trashedVideos = data.trashedVideos?.filter((candidate) => candidate.id !== videoId);
    writeBrowserData(data);
  },
  async createSnapshot(videoId: string, payload: unknown) {
    if (isTauri()) {
      return invoke<string>("create_video_snapshot", {
        videoId,
        payloadJson: JSON.stringify(payload),
      });
    }
    return id();
  },
};

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

export type InputAssetRecord = {
  id: string;
  videoId: string;
  kind: "audio" | "reference";
  originalName: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  createdAt: string;
};

export type VideoInputsRecord = {
  videoId: string;
  scriptText: string;
  pacingSeconds: number;
  pacingPreset: "calm" | "balanced" | "fast" | "custom";
  pacingMinSeconds: number;
  pacingMaxSeconds: number;
  audio: InputAssetRecord | null;
  references: InputAssetRecord[];
  updatedAt: string;
};

export type PlanSentenceRecord = { id: string; ordinal: number; text: string; startSeconds: number; endSeconds: number };
export type PlanGroupRecord = { id: string; ordinal: number; label: string; kind: string; sentenceIds: string[]; settingsLocked: boolean; promptLocked: boolean };
export type VisualPlanRecord = { videoId: string; timingSource: string; sentences: PlanSentenceRecord[]; groups: PlanGroupRecord[]; updatedAt: string };

export type PromptVersionRecord = {
  id: string;
  videoId: string;
  groupId: string;
  version: number;
  settingsJson: string;
  systemPrompt: string;
  userPrompt: string;
  createdAt: string;
};

export type ImageRenderRecord = {
  id: string;
  videoId: string;
  groupId: string;
  version: number;
  promptVersionId: string;
  fileName: string;
  relativePath: string;
  parentRenderId: string | null;
  editInstruction: string | null;
  kind: "generation" | "edit";
  isFinal: boolean;
  editStrength: string | null;
  maskPath: string | null;
  maskUsed: boolean;
  createdAt: string;
};

export type AppSettingRecord = {
  key: string;
  value: string;
};

export type ProviderKeyStatusRecord = {
  provider: string;
  configured: boolean;
};

export type ImageWorkspaceGroupRecord = {
  group: PlanGroupRecord;
  educationalPlan: EducationalVisualPlanRecord | null;
  promptVersions: PromptVersionRecord[];
  imageRenders: ImageRenderRecord[];
};

export type ImageWorkspaceRecord = {
  videoId: string;
  sentences: PlanSentenceRecord[];
  groups: ImageWorkspaceGroupRecord[];
  settings: AppSettingRecord[];
};
export type EducationalVisualPlanRecord = {
  stillId: string;
  visualPlanRowId: string;
  educationalObjective: string;
  visualIntent: string;
  subjectStrategy: string;
  imageSettings: Partial<Record<string, string>>;
  userPrompt: string;
  planSignature: string;
  visualStrategyMode: VisualStrategyMode;
  plannerVersion: string;
  createdAt: string;
  updatedAt: string;
};
export type VisualStrategyMode = "Auto Educational" | "Storytelling" | "Documentary" | "Scientific" | "Infographic Heavy";
export type WholeVideoEducationalPlanRecord = {
  strategyMode: VisualStrategyMode;
  plannerVersion: string;
  plans: EducationalVisualPlanRecord[];
};
export type StyleExtractionRecord = { styleDirective: string; imageSettings: Partial<Record<string, string>> };

export type BulkPlannedStillRecord = {
  visualPlanRowId: string;
  ordinal: number;
  narrationPreview: string;
  timestampStart: number;
  timestampEnd: number;
  visualType: string;
  imageSettings: Partial<Record<string, string>>;
  userPrompt: string;
  reason: string;
  settingsLocked: boolean;
  promptLocked: boolean;
};
export type BulkPlanSummaryRecord = {
  totalStills: number;
  visualTypeCounts: Record<string, number>;
  shortOverview: string;
};
export type BulkPlanResultRecord = {
  plannerVersion: number;
  summary: BulkPlanSummaryRecord;
  stills: BulkPlannedStillRecord[];
};

export type ImageJobRecord = {
  id: string;
  videoId: string;
  status: "queued" | "running" | "paused" | "stopped" | "completed" | "failed";
  totalItems: number;
  completedItems: number;
  failedItems: number;
  createdAt: string;
  updatedAt: string;
  items: { id: string; groupId: string; promptVersionId: string; status: string; attempts: number; lastError: string | null; renderId: string | null }[];
};
export type ExportResultRecord = { path: string; fileCount: number };
export type TimelineRecord = {
  videoId: string; durationSeconds: number; playheadSeconds: number; zoom: number; updatedAt: string;
  clips: { id: string; groupId: string; renderId: string | null; ordinal: number; startSeconds: number; endSeconds: number; label: string }[];
};

type BrowserData = {
  channels: ChannelRecord[];
  videos: VideoRecord[];
  trashedChannels?: ChannelRecord[];
  trashedVideos?: VideoRecord[];
  resume: ResumeRecord | null;
  inputs?: Record<string, VideoInputsRecord>;
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
  async startupDiagnostic(): Promise<string | null> {
    if (isTauri()) return invoke("startup_diagnostic");
    return null;
  },
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
  async renameChannel(channelId: string, name: string): Promise<void> {
    if (isTauri()) return invoke("rename_channel", { id: channelId, name });
    const data = readBrowserData();
    const channel = data.channels.find((c) => c.id === channelId);
    if (channel) { channel.name = name; channel.updatedAt = now(); }
    writeBrowserData(data);
  },
  async renameVideo(videoId: string, title: string): Promise<void> {
    if (isTauri()) return invoke("rename_video", { id: videoId, title });
    const data = readBrowserData();
    const video = data.videos.find((v) => v.id === videoId);
    if (video) { video.title = title; video.updatedAt = now(); }
    writeBrowserData(data);
  },
  async permanentlyDeleteChannel(channelId: string): Promise<void> {
    if (isTauri()) return invoke("permanent_delete_channel", { id: channelId });
    const data = readBrowserData();
    data.trashedChannels = data.trashedChannels?.filter((c) => c.id !== channelId);
    writeBrowserData(data);
  },
  async permanentlyDeleteVideo(videoId: string): Promise<void> {
    if (isTauri()) return invoke("permanent_delete_video", { id: videoId });
    const data = readBrowserData();
    data.trashedVideos = data.trashedVideos?.filter((v) => v.id !== videoId);
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
  async getVideoInputs(videoId: string): Promise<VideoInputsRecord> {
    if (isTauri()) return invoke("get_video_inputs", { videoId });
    const data = readBrowserData();
    return data.inputs?.[videoId] ?? {
      videoId, scriptText: "", pacingSeconds: 8, pacingPreset: "balanced", pacingMinSeconds: 6, pacingMaxSeconds: 10, audio: null, references: [], updatedAt: now(),
    };
  },
  async getImageWorkspace(videoId: string): Promise<ImageWorkspaceRecord> {
    if (isTauri()) return invoke("get_image_workspace", { videoId });
    const plan = await this.getVisualPlan(videoId);
    return {
      videoId,
      sentences: plan.sentences,
      groups: plan.groups.map((group) => ({ group, educationalPlan: null, promptVersions: [], imageRenders: [] })),
      settings: [],
    };
  },
  async saveAppSetting(key: string, value: string): Promise<void> {
    if (isTauri()) return invoke("save_app_setting", { key, value });
    localStorage.setItem(`${STORAGE_KEY}.setting.${key}`, value);
  },
  async getAppSetting(key: string): Promise<string | null> {
    if (isTauri()) return invoke("get_app_setting", { key });
    return localStorage.getItem(`${STORAGE_KEY}.setting.${key}`);
  },
  async saveProviderKey(provider: "openai" | "gemini", apiKey: string): Promise<void> {
    if (isTauri()) return invoke("save_provider_key", { provider, apiKey });
    localStorage.setItem(`${STORAGE_KEY}.key-status.${provider}`, apiKey ? "configured" : "");
  },
  async getProviderKeyStatus(provider: "openai" | "gemini"): Promise<ProviderKeyStatusRecord> {
    if (isTauri()) return invoke("get_provider_key_status", { provider });
    return { provider, configured: localStorage.getItem(`${STORAGE_KEY}.key-status.${provider}`) === "configured" };
  },
  async createPromptVersion(
    videoId: string,
    groupId: string,
    settingsJson: string,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<PromptVersionRecord> {
    if (isTauri()) {
      return invoke("create_prompt_version", {
        videoId,
        groupId,
        settingsJson,
        systemPrompt,
        userPrompt,
      });
    }
    return {
      id: id(),
      videoId,
      groupId,
      version: 1,
      settingsJson,
      systemPrompt,
      userPrompt,
      createdAt: now(),
    };
  },
  async listPromptVersions(videoId: string, groupId: string): Promise<PromptVersionRecord[]> {
    if (isTauri()) return invoke("list_prompt_versions", { videoId, groupId });
    return [];
  },
  async listImageRenders(videoId: string, groupId: string): Promise<ImageRenderRecord[]> {
    if (isTauri()) return invoke("list_image_renders", { videoId, groupId });
    return [];
  },
  async generateImageRender(
    videoId: string,
    groupId: string,
    promptVersionId: string,
    systemPrompt: string,
    userPrompt: string,
    settingsJson: string,
  ): Promise<ImageRenderRecord> {
    if (isTauri()) {
      return invoke("generate_image_render", {
        videoId,
        groupId,
        promptVersionId,
        systemPrompt,
        userPrompt,
        settingsJson,
      });
    }
    return {
      id: id(),
      videoId,
      groupId,
      version: 1,
      promptVersionId,
      fileName: "render-v1.png",
      relativePath: `renders/${groupId}/render-v1.png`,
      parentRenderId: null,
      editInstruction: null,
      kind: "generation",
      isFinal: true,
      editStrength: null,
      maskPath: null,
      maskUsed: false,
      createdAt: now(),
    };
  },
  async editImageRender(sourceRenderId: string, instruction: string, maskDataUrl?: string, editStrength = "Low"): Promise<ImageRenderRecord> {
    if (isTauri()) return invoke("edit_image_render", { sourceRenderId, instruction, maskDataUrl: maskDataUrl || null, editStrength });
    throw new Error("Image editing requires the native application.");
  },
  async getRenderDataUrl(renderId: string): Promise<string> {
    if (isTauri()) return invoke("get_render_data_url", { renderId });
    return "";
  },
  async pickDownloadFolder(): Promise<string | null> {
    if (isTauri()) return invoke("pick_download_folder");
    return null;
  },
  async copyRenderToFolder(renderId: string, folderPath: string): Promise<string> {
    if (isTauri()) return invoke("copy_render_to_folder", { renderId, folderPath });
    throw new Error("Download requires the native application.");
  },
  async exportLatestStills(videoId: string): Promise<ExportResultRecord | null> {
    if (isTauri()) return invoke("export_latest_stills", { videoId });
    throw new Error("Export requires the native application.");
  },
  async exportProjectBundle(videoId: string): Promise<ExportResultRecord | null> {
    if (isTauri()) return invoke("export_project_bundle", { videoId });
    throw new Error("Export requires the native application.");
  },
  async importProjectBundle(): Promise<VideoRecord | null> {
    if (isTauri()) return invoke("import_project_bundle");
    throw new Error("Import requires the native application.");
  },
  async buildTimeline(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("build_timeline", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async getTimeline(videoId: string): Promise<TimelineRecord> {
    if (isTauri()) return invoke("get_timeline", { videoId });
    throw new Error("Timeline requires the native application.");
  },
  async updateTimelineView(videoId: string, playhead: number, zoom: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_timeline_view", { videoId, playhead, zoom });
    throw new Error("Timeline requires the native application.");
  },
  async updateTimelineClip(videoId: string, clipId: string, start: number, end: number): Promise<TimelineRecord> {
    if (isTauri()) return invoke("update_timeline_clip", { videoId, clipId, start, end });
    throw new Error("Timeline requires the native application.");
  },
  async createImageJob(videoId: string): Promise<ImageJobRecord> {
    if (isTauri()) return invoke("create_image_job", { videoId });
    throw new Error("Bulk jobs require the native application.");
  },
  async getLatestImageJob(videoId: string): Promise<ImageJobRecord | null> {
    if (isTauri()) return invoke("get_latest_image_job", { videoId });
    return null;
  },
  async controlImageJob(jobId: string, action: "pause" | "resume" | "stop"): Promise<ImageJobRecord> {
    if (isTauri()) return invoke("control_image_job", { jobId, action });
    throw new Error("Bulk jobs require the native application.");
  },
  async saveVideoInputs(videoId: string, scriptText: string, pacingSeconds: number) {
    if (isTauri()) return invoke<VideoInputsRecord>("save_video_inputs", { videoId, scriptText, pacingSeconds });
    const data = readBrowserData();
    const existing = data.inputs?.[videoId] ?? {
      videoId, scriptText: "", pacingSeconds: 8, pacingPreset: "balanced" as const, pacingMinSeconds: 6, pacingMaxSeconds: 10, audio: null, references: [], updatedAt: now(),
    };
    const inputs = { ...existing, scriptText, pacingSeconds, updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return inputs;
  },
  async saveVideoPacing(videoId: string, preset: "calm" | "balanced" | "fast" | "custom", minSeconds: number, maxSeconds: number) {
    if (isTauri()) return invoke<VideoInputsRecord>("save_video_pacing", { videoId, preset, minSeconds, maxSeconds });
    const data = readBrowserData();
    const existing = await this.getVideoInputs(videoId);
    const inputs = { ...existing, pacingPreset: preset, pacingMinSeconds: minSeconds, pacingMaxSeconds: maxSeconds, pacingSeconds: Math.round((minSeconds + maxSeconds) / 2), updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return inputs;
  },
  async pickAndImportAsset(videoId: string, kind: "audio" | "reference") {
    if (isTauri()) return invoke<InputAssetRecord | null>("pick_and_import_asset", { videoId, kind });
    return null;
  },
  async deletePromptVersion(promptVersionId: string): Promise<void> {
    if (isTauri()) return invoke("delete_prompt_version", { promptVersionId });
  },
  async getAssetDataUrl(assetId: string): Promise<string> {
    if (isTauri()) return invoke("get_asset_data_url", { assetId });
    return "";
  },
  async setFinalRender(renderId: string, isFinal: boolean): Promise<ImageRenderRecord> {
    if (isTauri()) return invoke("set_final_render", { renderId, isFinal });
    throw new Error("Final image selection requires the native application.");
  },
  async deleteImageRender(renderId: string): Promise<void> {
    if (isTauri()) return invoke("delete_image_render", { renderId });
  },
  async resetImageWorkflow(videoId: string): Promise<void> {
    if (isTauri()) return invoke("reset_image_workflow", { videoId });
  },
  async suggestImagePrompt(
    videoId: string,
    groupId: string,
    settingsJson: string,
    styleDirective: string,
  ): Promise<string> {
    if (isTauri()) return invoke("suggest_image_prompt", { videoId, groupId, settingsJson, styleDirective });
    const plan = await this.getVisualPlan(videoId);
    const group = plan.groups.find((item) => item.id === groupId);
    const text = group?.sentenceIds.map((sentenceId) => plan.sentences.find((sentence) => sentence.id === sentenceId)?.text).filter(Boolean).join(" ");
    return `Create a direct visual depiction of: ${text ?? "this narration"}.`;
  },
  async planEducationalVisual(
    videoId: string,
    groupId: string,
    settingsJson: string,
    styleDirective: string,
  ): Promise<EducationalVisualPlanRecord> {
    if (isTauri()) return invoke("plan_educational_visual", { videoId, groupId, settingsJson, styleDirective });
    throw new Error("Educational visual planning requires the native application.");
  },
  async planWholeVideoEducationalVisuals(
    videoId: string,
    settingsJson: string,
    styleDirective: string,
    strategyMode: VisualStrategyMode,
  ): Promise<WholeVideoEducationalPlanRecord> {
    if (isTauri()) return invoke("plan_whole_video_educational_visuals", { videoId, settingsJson, styleDirective, strategyMode });
    throw new Error("Whole-video educational planning requires the native application.");
  },
  async extractReferenceStyle(assetId: string): Promise<StyleExtractionRecord> {
    if (isTauri()) return invoke("extract_reference_style", { assetId });
    throw new Error("Style extraction requires the native application.");
  },
  async extractImageSettingsFromDirective(directive: string): Promise<StyleExtractionRecord> {
    if (isTauri()) return invoke("extract_image_settings_from_directive", { directive });
    throw new Error("Image settings extraction requires the native application.");
  },
  async suggestStillPrompt(videoId: string, groupId: string, styleDirective: string, baseSettingsJson: string): Promise<BulkPlannedStillRecord> {
    if (isTauri()) return invoke("suggest_still_prompt", { videoId, groupId, styleDirective, baseSettingsJson });
    throw new Error("Prompt suggestion requires the native application.");
  },
  async planBulkVisuals(videoId: string, styleDirective: string, baseSettingsJson: string, creativeInstruction: string): Promise<BulkPlanResultRecord> {
    if (isTauri()) return invoke("plan_bulk_visuals", { videoId, styleDirective, baseSettingsJson, creativeInstruction });
    throw new Error("Bulk planning requires the native application.");
  },
  async approveBulkPlan(videoId: string, styleDirective: string, stills: BulkPlannedStillRecord[]): Promise<number> {
    if (isTauri()) return invoke("approve_bulk_plan", { videoId, styleDirective, stills });
    throw new Error("Bulk plan approval requires the native application.");
  },
  async importBrowserAsset(videoId: string, kind: "audio" | "reference", file: File) {
    if (isTauri()) throw new Error("Browser-file import is only available in the web preview.");
    const data = readBrowserData();
    const existing = await this.getVideoInputs(videoId);
    const asset: InputAssetRecord = {
      id: crypto.randomUUID(),
      videoId,
      kind,
      originalName: file.name,
      relativePath: `browser-preview/${file.name}`,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      createdAt: now(),
    };
    const inputs = kind === "audio"
      ? { ...existing, audio: asset, updatedAt: now() }
      : { ...existing, references: [...existing.references, asset], updatedAt: now() };
    (data.inputs ??= {})[videoId] = inputs;
    writeBrowserData(data);
    return asset;
  },
  async removeInputAsset(assetId: string) {
    if (isTauri()) return invoke<void>("remove_input_asset", { assetId });
  },
  async pickScriptText() {
    if (isTauri()) return invoke<string | null>("pick_script_text");
    return null;
  },
  async readBrowserScript(file: File) {
    if (file.size > 1_000_000) throw new Error("Script exceeds the 1 MB limit.");
    return file.text();
  },
  async generateVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("generate_visual_plan", { videoId });
    const inputs = await this.getVideoInputs(videoId);
    const cleanedScript = inputs.scriptText
      .replace(/<#\s*\d+(?:\.\d+)?\s*#>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const texts = cleanedScript.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((text) => text.trim()) ?? [];
    let cursor = 0;
    const sentences = texts.map((text, index) => {
      const duration = Math.max(1, text.split(/\s+/).length * 0.4);
      const sentence = { id: `s${index + 1}`, ordinal: index + 1, text, startSeconds: cursor, endSeconds: cursor + duration };
      cursor += duration; return sentence;
    });
    const groups = sentences.map((sentence, index) => ({ id: `g${index + 1}`, ordinal: index + 1, label: `Scene ${index + 1}`, kind: index ? "subject" : "establishing", sentenceIds: [sentence.id], settingsLocked: false, promptLocked: false }));
    const plan = { videoId, timingSource: "estimated", sentences, groups, updatedAt: now() };
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    localStorage.setItem(`${STORAGE_KEY}.plan.original.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async getVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("get_visual_plan", { videoId });
    const stored = localStorage.getItem(`${STORAGE_KEY}.plan.${videoId}`);
    if (!stored) throw new Error("Visual plan has not been generated.");
    return JSON.parse(stored) as VisualPlanRecord;
  },
  async movePlanSentence(videoId: string, sentenceId: string, targetGroupId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("move_plan_sentence", { videoId, sentenceId, targetGroupId });
    const plan = await this.getVisualPlan(videoId);
    const source = plan.groups.findIndex((group) => group.sentenceIds.includes(sentenceId));
    const target = plan.groups.findIndex((group) => group.id === targetGroupId);
    if (Math.abs(source - target) > 1) throw new Error("Sentences may only move to an adjacent scene.");
    plan.groups[source].sentenceIds = plan.groups[source].sentenceIds.filter((id) => id !== sentenceId);
    plan.groups[target].sentenceIds.push(sentenceId);
    plan.groups = plan.groups.filter((group) => group.sentenceIds.length);
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async createPlanGroup(videoId: string, sentenceId: string, insertIndex: number): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("create_plan_group", { videoId, sentenceId, insertIndex });
    const plan = await this.getVisualPlan(videoId);
    const source = plan.groups.findIndex((group) => group.sentenceIds.includes(sentenceId));
    if (source < 0) throw new Error("Sentence was not found.");
    plan.groups[source].sentenceIds = plan.groups[source].sentenceIds.filter((id) => id !== sentenceId);
    plan.groups = plan.groups.filter((group) => group.sentenceIds.length);
    plan.groups.splice(Math.min(insertIndex, plan.groups.length), 0, {
      id: crypto.randomUUID(), ordinal: 0, label: "New scene", kind: "custom", sentenceIds: [sentenceId], settingsLocked: false, promptLocked: false,
    });
    plan.groups.sort((a, b) => Number(a.sentenceIds[0].slice(1)) - Number(b.sentenceIds[0].slice(1)));
    plan.groups.forEach((group, index) => { group.ordinal = index + 1; });
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, JSON.stringify(plan));
    return plan;
  },
  async resetVisualPlan(videoId: string): Promise<VisualPlanRecord> {
    if (isTauri()) return invoke("reset_visual_plan", { videoId });
    const original = localStorage.getItem(`${STORAGE_KEY}.plan.original.${videoId}`);
    if (!original) throw new Error("Original visual plan was not found.");
    localStorage.setItem(`${STORAGE_KEY}.plan.${videoId}`, original);
    return JSON.parse(original) as VisualPlanRecord;
  },
};

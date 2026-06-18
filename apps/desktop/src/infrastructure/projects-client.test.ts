import { beforeEach, describe, expect, it } from "vitest";
import { projectsClient } from "./projects-client";

describe("projectsClient browser fallback", () => {
  beforeEach(() => localStorage.clear());

  it("creates, trashes, and restores local project records", async () => {
    const channel = await projectsClient.createChannel("Beneath the Fins");
    const video = await projectsClient.createVideo(channel.id, "Twilight Zone");

    expect(await projectsClient.listChannels()).toHaveLength(1);
    expect(await projectsClient.listVideos(channel.id)).toHaveLength(1);

    await projectsClient.trashVideo(video.id);
    expect(await projectsClient.listVideos(channel.id)).toHaveLength(0);
    expect(await projectsClient.listVideos(channel.id, true)).toHaveLength(1);

    await projectsClient.restoreVideo(video.id);
    expect(await projectsClient.listVideos(channel.id)).toHaveLength(1);
  });

  it("persists script and pacing in the browser fallback", async () => {
    const channel = await projectsClient.createChannel("Channel");
    const video = await projectsClient.createVideo(channel.id, "Video");
    await projectsClient.saveVideoInputs(video.id, "Narration text", 10);

    expect(await projectsClient.getVideoInputs(video.id)).toMatchObject({
      scriptText: "Narration text",
      pacingSeconds: 10,
    });
  });
});

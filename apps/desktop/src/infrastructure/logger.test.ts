import { describe, expect, it } from "vitest";
import { createLogEntry } from "./logger";

describe("createLogEntry", () => {
  it("redacts secret-like context fields", () => {
    const entry = createLogEntry("info", "provider_configured", {
      provider: "openai",
      apiKey: "should-not-leak",
    });

    expect(entry.context).toEqual({
      provider: "openai",
      apiKey: "[REDACTED]",
    });
  });
});

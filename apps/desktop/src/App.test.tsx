import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it } from "vitest";
import { App } from "./App";
import { useAppStore } from "./store/app-store";

describe("application workflow navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({
      stage: "home",
      activeChannelId: null,
      activeChannelName: null,
      activeVideoId: null,
      activeVideoTitle: null,
    });
  });

  it("opens the create-channel dialog and prevents premature downstream navigation", async () => {
    render(<App />);

    const inputs = screen.getByRole("button", { name: /^inputs$/i });
    const visuals = screen.getByRole("button", { name: /^visuals$/i });
    expect(inputs).toBeDisabled();
    expect(visuals).toBeDisabled();

    await waitFor(() => expect(screen.getByRole("button", { name: /^\+ add channel$/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /^\+ add channel$/i }));
    expect(screen.getByRole("heading", { name: /create channel/i })).toBeInTheDocument();
  });
});

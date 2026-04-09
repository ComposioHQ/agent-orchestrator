import "@testing-library/jest-dom/vitest";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../Terminal";

describe("Terminal", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ terminalUrl: "http://localhost:14800/terminal/ao-77/" }),
      })),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the iframe terminal URL and supports fullscreen toggling", async () => {
    const { container } = render(<Terminal sessionId="ao-77" />);

    await waitFor(() =>
      expect(screen.getByTitle("Terminal: ao-77").getAttribute("src")).toBe(
        "http://localhost:14800/terminal/ao-77/",
      ),
    );

    expect(fetch).toHaveBeenCalledWith("/api/sessions/ao-77/terminal", {
      method: "POST",
      cache: "no-store",
    });

    fireEvent.click(screen.getByRole("button", { name: "fullscreen" }));
    expect(container.firstChild).not.toBeNull();
    expect((container.firstChild as Element).classList.contains("fixed")).toBe(true);
    expect((container.firstChild as Element).classList.contains("inset-0")).toBe(true);
    expect(screen.getByRole("button", { name: "exit fullscreen" })).toBeTruthy();
  });

  it("shows connection error when terminal authorization request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    render(<Terminal sessionId="ao-error" />);

    await waitFor(() =>
      expect(screen.getAllByText("Failed to connect to terminal server").length).toBeGreaterThan(0),
    );
  });

  it("clears refresh interval on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ terminalUrl: "http://localhost:14800/terminal/ao-77/" }),
    })));

    const { unmount } = render(<Terminal sessionId="ao-77" />);

    await waitFor(() =>
      expect(screen.getByTitle("Terminal: ao-77").getAttribute("src")).toBe(
        "http://localhost:14800/terminal/ao-77/",
      ),
    );

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});

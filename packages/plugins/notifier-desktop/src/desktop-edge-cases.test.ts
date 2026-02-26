/**
 * Edge case tests for the desktop notifier plugin.
 * Covers platform detection and notification dispatch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    cb(null);
  }),
}));

// Mock os.platform
vi.mock("node:os", () => ({
  platform: vi.fn().mockReturnValue("darwin"),
}));

import * as child_process from "node:child_process";
import * as os from "node:os";
import desktopPlugin from "./index.js";
import type { OrchestratorEvent } from "@composio/ao-core";

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.working",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-app",
    timestamp: new Date("2025-01-01T00:00:00Z"),
    message: "Test notification",
    data: {},
    ...overrides,
  };
}

describe("notifier-desktop edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports correct manifest", () => {
    expect(desktopPlugin.manifest.name).toBe("desktop");
    expect(desktopPlugin.manifest.slot).toBe("notifier");
  });

  it("creates a notifier instance", () => {
    const notifier = desktopPlugin.create();
    expect(notifier.name).toBe("desktop");
    expect(typeof notifier.notify).toBe("function");
  });

  describe("notify on macOS", () => {
    it("calls osascript on darwin platform", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent());

      expect(child_process.execFile).toHaveBeenCalledWith(
        "osascript",
        expect.arrayContaining(["-e"]),
        expect.any(Function),
      );
    });

    it("includes event type in notification script", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ message: "app-1: working → ci_failed" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      const script = args[args.length - 1];
      expect(script).toContain("ci_failed");
    });
  });

  describe("notify on Linux", () => {
    it("calls notify-send on linux platform", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent());

      expect(child_process.execFile).toHaveBeenCalledWith(
        "notify-send",
        expect.any(Array),
        expect.any(Function),
      );
    });

    it("includes --urgency=critical for urgent events", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      expect(args).toContain("--urgency=critical");
    });

    it("omits urgency flag for non-urgent events", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ priority: "info" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      // Non-urgent events just get [title, message] without urgency flag
      expect(args.some((a) => a.includes("--urgency"))).toBe(false);
    });

    it("includes title and message as positional args", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ sessionId: "be-1", message: "Test msg" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      expect(args).toContain("Agent Orchestrator [be-1]");
      expect(args).toContain("Test msg");
    });
  });

  describe("unsupported platforms", () => {
    it("does not throw on unsupported platforms", async () => {
      vi.mocked(os.platform).mockReturnValue("win32" as NodeJS.Platform);
      const notifier = desktopPlugin.create();

      // Should not throw
      await notifier.notify(makeEvent());
      // execFile should NOT be called on unsupported platforms
      expect(child_process.execFile).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("rejects when execFile fails", async () => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      vi.mocked(child_process.execFile).mockImplementation(
        (_cmd: string, _args: unknown, cb: unknown) => {
          (cb as (err: Error | null) => void)(new Error("osascript failed"));
          return {} as any;
        },
      );

      const notifier = desktopPlugin.create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow("osascript failed");
    });
  });

  describe("title formatting", () => {
    it("uses URGENT prefix for urgent events", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ priority: "urgent", sessionId: "app-5" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      expect(args).toContain("URGENT [app-5]");
    });

    it("uses Agent Orchestrator prefix for non-urgent events", async () => {
      vi.mocked(os.platform).mockReturnValue("linux");
      const notifier = desktopPlugin.create();

      await notifier.notify(makeEvent({ priority: "info", sessionId: "app-3" }));

      const args = vi.mocked(child_process.execFile).mock.calls[0][1] as string[];
      expect(args).toContain("Agent Orchestrator [app-3]");
    });
  });
});

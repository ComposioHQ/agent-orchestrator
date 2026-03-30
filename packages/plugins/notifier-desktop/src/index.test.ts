import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { OrchestratorEvent, NotifyAction } from "@composio/ao-core";

// Mock node:child_process
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

// Mock node:os
vi.mock("node:os", () => ({
  platform: vi.fn(() => "darwin"),
}));

import { execFile } from "node:child_process";
import { platform } from "node:os";
import { manifest, create, escapeAppleScript } from "./index.js";

const mockExecFile = execFile as unknown as Mock;
const mockPlatform = platform as unknown as Mock;

function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
  return {
    id: "evt-1",
    type: "session.spawned",
    priority: "info",
    sessionId: "app-1",
    projectId: "my-project",
    timestamp: new Date("2025-01-01T00:00:00Z"),
    message: "Session app-1 spawned",
    data: {},
    ...overrides,
  };
}

describe("notifier-desktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue("darwin");
    // By default terminal-notifier succeeds
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        cb(null);
      },
    );
  });

  describe("manifest", () => {
    it("has correct metadata", () => {
      expect(manifest.name).toBe("desktop");
      expect(manifest.slot).toBe("notifier");
      expect(manifest.version).toBe("0.1.0");
    });
  });

  describe("escapeAppleScript", () => {
    it("escapes double quotes", () => {
      expect(escapeAppleScript('hello "world"')).toBe('hello \\"world\\"');
    });

    it("escapes backslashes", () => {
      expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
    });

    it("escapes both backslashes and quotes", () => {
      expect(escapeAppleScript('say \\"hi\\"')).toBe('say \\\\\\"hi\\\\\\"');
    });

    it("returns plain strings unchanged", () => {
      expect(escapeAppleScript("hello world")).toBe("hello world");
    });
  });

  describe("create", () => {
    it("returns a notifier with name 'desktop'", () => {
      const notifier = create();
      expect(notifier.name).toBe("desktop");
    });

    it("has notify and notifyWithActions methods", () => {
      const notifier = create();
      expect(typeof notifier.notify).toBe("function");
      expect(typeof notifier.notifyWithActions).toBe("function");
    });
  });

  describe("notify", () => {
    it("calls terminal-notifier on macOS", async () => {
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe("terminal-notifier");
    });

    it("includes session ID in title", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ sessionId: "backend-5" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      const titleIdx = args.indexOf("-title");
      expect(args[titleIdx + 1]).toContain("backend-5");
    });

    it("includes event message in notification body", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ message: "CI is failing" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      const msgIdx = args.indexOf("-message");
      expect(args[msgIdx + 1]).toContain("CI is failing");
    });

    it("uses URGENT prefix for urgent priority", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      const titleIdx = args.indexOf("-title");
      expect(args[titleIdx + 1]).toContain("URGENT");
    });

    it("uses 'Agent Orchestrator' prefix for non-urgent priority", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "action" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      const titleIdx = args.indexOf("-title");
      expect(args[titleIdx + 1]).toContain("Agent Orchestrator");
    });

    it("includes sound for urgent notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-sound");
    });

    it("does not include sound for info notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("does not include sound for action notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "action" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("does not include sound for warning notifications", async () => {
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "warning" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("respects sound=false config even for urgent", async () => {
      const notifier = create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("-sound");
    });

    it("includes dashboard URL as open action", async () => {
      const notifier = create({ port: 4000 });
      await notifier.notify(makeEvent());

      const args = mockExecFile.mock.calls[0][1] as string[];
      const openIdx = args.indexOf("-open");
      expect(args[openIdx + 1]).toBe("http://localhost:4000");
    });

    it("defaults to port 3000 for dashboard URL", async () => {
      const notifier = create();
      await notifier.notify(makeEvent());

      const args = mockExecFile.mock.calls[0][1] as string[];
      const openIdx = args.indexOf("-open");
      expect(args[openIdx + 1]).toBe("http://localhost:3000");
    });

    it("falls back to osascript when terminal-notifier fails", async () => {
      mockExecFile
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error("terminal-notifier not found"));
        })
        .mockImplementationOnce((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(null);
        });

      const notifier = create();
      await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile.mock.calls[0][0]).toBe("terminal-notifier");
      expect(mockExecFile.mock.calls[1][0]).toBe("osascript");
    });
  });

  describe("notify on Linux", () => {
    it("calls notify-send on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent());

      expect(mockExecFile).toHaveBeenCalledOnce();
      expect(mockExecFile.mock.calls[0][0]).toBe("notify-send");
    });

    it("includes --urgency=critical for urgent on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--urgency=critical");
      // Options must come before title/message for notify-send
      const urgencyIdx = args.indexOf("--urgency=critical");
      const titleIdx = args.findIndex((a: string) => a.includes("URGENT"));
      expect(urgencyIdx).toBeLessThan(titleIdx);
    });

    it("includes --urgency=critical for urgent even when sound is disabled", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create({ sound: false });
      await notifier.notify(makeEvent({ priority: "urgent" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("--urgency=critical");
    });

    it("does not include --urgency=critical for info on Linux", async () => {
      mockPlatform.mockReturnValue("linux");
      const notifier = create();
      await notifier.notify(makeEvent({ priority: "info" }));

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).not.toContain("--urgency=critical");
    });
  });

  describe("notify on unsupported platform", () => {
    it("resolves without error on unsupported platform", async () => {
      mockPlatform.mockReturnValue("win32");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const notifier = create();
      await expect(notifier.notify(makeEvent())).resolves.toBeUndefined();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not supported on win32"));
      warnSpy.mockRestore();
    });
  });

  describe("notifyWithActions", () => {
    it("includes action labels in the message", async () => {
      const notifier = create();
      const actions: NotifyAction[] = [
        { label: "Merge", url: "https://github.com/pr/1" },
        { label: "Kill", callbackEndpoint: "/api/kill" },
      ];
      await notifier.notifyWithActions!(makeEvent(), actions);

      const args = mockExecFile.mock.calls[0][1] as string[];
      const msgIdx = args.indexOf("-message");
      const messageArg = args[msgIdx + 1];
      expect(messageArg).toContain("Merge");
      expect(messageArg).toContain("Kill");
    });

    it("includes sound for urgent with actions", async () => {
      const notifier = create();
      const actions: NotifyAction[] = [{ label: "Fix", url: "https://example.com" }];
      await notifier.notifyWithActions!(makeEvent({ priority: "urgent" }), actions);

      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("-sound");
    });
  });

  describe("error handling", () => {
    it("rejects when both terminal-notifier and osascript fail", async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
          cb(new Error("command not found"));
        },
      );
      const notifier = create();
      await expect(notifier.notify(makeEvent())).rejects.toThrow("command not found");
    });
  });
});

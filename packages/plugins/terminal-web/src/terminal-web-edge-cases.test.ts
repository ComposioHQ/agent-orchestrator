/**
 * Edge case tests for the terminal-web plugin.
 * Covers openSession, openAll, and isSessionOpen behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Session } from "@composio/ao-core";
import terminalWebPlugin from "./index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: null,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe("terminal-web plugin", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exports correct manifest", () => {
    expect(terminalWebPlugin.manifest.name).toBe("web");
    expect(terminalWebPlugin.manifest.slot).toBe("terminal");
  });

  describe("openSession", () => {
    it("logs URL with default dashboard URL", async () => {
      const terminal = terminalWebPlugin.create();
      const session = makeSession({ id: "app-1" });

      await terminal.openSession(session);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("app-1"),
      );
    });

    it("logs URL with custom dashboard URL", async () => {
      const terminal = terminalWebPlugin.create({ dashboardUrl: "http://localhost:4200" });
      const session = makeSession({ id: "app-2" });

      await terminal.openSession(session);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("localhost:4200"),
      );
    });

    it("tracks opened sessions", async () => {
      const terminal = terminalWebPlugin.create();
      const session = makeSession({ id: "app-1" });

      await terminal.openSession(session);

      if (terminal.isSessionOpen) {
        const isOpen = await terminal.isSessionOpen(session);
        expect(isOpen).toBe(true);
      }
    });
  });

  describe("openAll", () => {
    it("opens multiple sessions and logs summary", async () => {
      const terminal = terminalWebPlugin.create();
      const sessions = [
        makeSession({ id: "app-1" }),
        makeSession({ id: "app-2" }),
        makeSession({ id: "app-3" }),
      ];

      await terminal.openAll(sessions);

      // openAll logs a single summary message with count
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("3 sessions"),
      );

      // All sessions should be tracked as open
      if (terminal.isSessionOpen) {
        for (const s of sessions) {
          expect(await terminal.isSessionOpen(s)).toBe(true);
        }
      }
    });

    it("handles empty session list with zero count", async () => {
      const terminal = terminalWebPlugin.create();
      await terminal.openAll([]);
      // openAll still logs summary with 0 count
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("0 sessions"),
      );
    });
  });

  describe("isSessionOpen", () => {
    it("returns false for unopened session", async () => {
      const terminal = terminalWebPlugin.create();
      const session = makeSession({ id: "app-99" });

      if (terminal.isSessionOpen) {
        const isOpen = await terminal.isSessionOpen(session);
        expect(isOpen).toBe(false);
      }
    });

    it("maintains separate state per instance", async () => {
      const terminal1 = terminalWebPlugin.create();
      const terminal2 = terminalWebPlugin.create();
      const session = makeSession({ id: "app-1" });

      await terminal1.openSession(session);

      if (terminal1.isSessionOpen && terminal2.isSessionOpen) {
        expect(await terminal1.isSessionOpen(session)).toBe(true);
        expect(await terminal2.isSessionOpen(session)).toBe(false);
      }
    });
  });
});

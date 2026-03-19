import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  appendTerminalCapture,
  readEvents,
  readTerminalLog,
  getSessionEventDir,
  logSessionCreated,
  logSessionStarted,
  logStatusChanged,
  logSessionKilled,
  logSessionRestored,
  logSessionError,
} from "../event-log.js";

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = join(tmpdir(), `ao-test-events-${randomUUID()}`);
  mkdirSync(sessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("getSessionEventDir", () => {
  it("returns a directory path based on session ID", () => {
    const dir = getSessionEventDir(sessionsDir, "app-1");
    expect(dir).toBe(join(sessionsDir, "app-1.d"));
  });

  it("rejects invalid session IDs", () => {
    expect(() => getSessionEventDir(sessionsDir, "../hack")).toThrow("Invalid session ID");
    expect(() => getSessionEventDir(sessionsDir, "foo/bar")).toThrow("Invalid session ID");
  });
});

describe("appendEvent + readEvents", () => {
  it("writes and reads a single event", () => {
    appendEvent(sessionsDir, "app-1", "session.created", { projectId: "test" });

    const events = readEvents(sessionsDir, "app-1");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("session.created");
    expect(events[0].data).toEqual({ projectId: "test" });
    expect(events[0].ts).toBeTruthy();
  });

  it("appends multiple events in order", () => {
    appendEvent(sessionsDir, "app-1", "session.created", {});
    appendEvent(sessionsDir, "app-1", "session.started", { runtimeId: "tmux-1" });
    appendEvent(sessionsDir, "app-1", "session.status_changed", {
      from: "spawning",
      to: "working",
    });

    const events = readEvents(sessionsDir, "app-1");
    expect(events).toHaveLength(3);
    expect(events[0].event).toBe("session.created");
    expect(events[1].event).toBe("session.started");
    expect(events[2].event).toBe("session.status_changed");
  });

  it("returns empty array for non-existent session", () => {
    const events = readEvents(sessionsDir, "nonexistent");
    expect(events).toEqual([]);
  });

  it("filters by event type", () => {
    appendEvent(sessionsDir, "app-1", "session.created", {});
    appendEvent(sessionsDir, "app-1", "session.status_changed", {});
    appendEvent(sessionsDir, "app-1", "pr.created", {});
    appendEvent(sessionsDir, "app-1", "session.status_changed", {});

    const events = readEvents(sessionsDir, "app-1", {
      types: ["session.status_changed"],
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event === "session.status_changed")).toBe(true);
  });

  it("supports limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      appendEvent(sessionsDir, "app-1", "session.status_changed", { index: i });
    }

    const page1 = readEvents(sessionsDir, "app-1", { limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0].data["index"]).toBe(0);

    const page2 = readEvents(sessionsDir, "app-1", { limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0].data["index"]).toBe(3);

    const lastPage = readEvents(sessionsDir, "app-1", { limit: 5, offset: 8 });
    expect(lastPage).toHaveLength(2);
  });

  it("writes valid JSONL format", () => {
    appendEvent(sessionsDir, "app-1", "session.created", { key: "value" });
    appendEvent(sessionsDir, "app-1", "session.started", {});

    const filePath = join(getSessionEventDir(sessionsDir, "app-1"), "events.jsonl");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    // Each line should be valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("ts");
      expect(parsed).toHaveProperty("event");
      expect(parsed).toHaveProperty("data");
    }
  });

  it("creates directory automatically", () => {
    const eventDir = getSessionEventDir(sessionsDir, "new-session");
    expect(existsSync(eventDir)).toBe(false);

    appendEvent(sessionsDir, "new-session", "session.created", {});
    expect(existsSync(eventDir)).toBe(true);
  });
});

describe("appendTerminalCapture + readTerminalLog", () => {
  it("captures terminal output to terminal.log", () => {
    appendTerminalCapture(sessionsDir, "app-1", "$ ls\nfile1.txt\nfile2.txt");

    const log = readTerminalLog(sessionsDir, "app-1");
    expect(log).not.toBeNull();
    expect(log).toContain("file1.txt");
    expect(log).toContain("file2.txt");
    // Should have a timestamp header
    expect(log).toMatch(/^--- \d{4}-\d{2}-\d{2}T/m);
  });

  it("appends multiple captures", () => {
    appendTerminalCapture(sessionsDir, "app-1", "output-1");
    appendTerminalCapture(sessionsDir, "app-1", "output-2");

    const log = readTerminalLog(sessionsDir, "app-1");
    expect(log).toContain("output-1");
    expect(log).toContain("output-2");
  });

  it("skips empty output", () => {
    appendTerminalCapture(sessionsDir, "app-1", "");
    appendTerminalCapture(sessionsDir, "app-1", "   ");

    const log = readTerminalLog(sessionsDir, "app-1");
    expect(log).toBeNull();
  });

  it("records terminal.captured event in event log", () => {
    appendTerminalCapture(sessionsDir, "app-1", "some output");

    const events = readEvents(sessionsDir, "app-1");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("terminal.captured");
    expect(events[0].data["lines"]).toBe(1);
  });

  it("returns null for non-existent session", () => {
    const log = readTerminalLog(sessionsDir, "nonexistent");
    expect(log).toBeNull();
  });
});

describe("convenience helpers", () => {
  it("logSessionCreated writes correct event", () => {
    logSessionCreated(sessionsDir, "app-1", {
      projectId: "test",
      branch: "feat/test",
      workspacePath: "/tmp/ws",
      agent: "claude-code",
      issueId: "123",
    });

    const events = readEvents(sessionsDir, "app-1");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("session.created");
    expect(events[0].data).toEqual({
      projectId: "test",
      branch: "feat/test",
      workspacePath: "/tmp/ws",
      agent: "claude-code",
      issueId: "123",
    });
  });

  it("logSessionStarted writes correct event", () => {
    logSessionStarted(sessionsDir, "app-1", {
      runtimeId: "tmux-abc",
      runtimeName: "tmux",
    });

    const events = readEvents(sessionsDir, "app-1");
    expect(events[0].event).toBe("session.started");
    expect(events[0].data["runtimeId"]).toBe("tmux-abc");
  });

  it("logStatusChanged writes correct event", () => {
    logStatusChanged(sessionsDir, "app-1", { from: "spawning", to: "working" });

    const events = readEvents(sessionsDir, "app-1");
    expect(events[0].event).toBe("session.status_changed");
    expect(events[0].data).toEqual({ from: "spawning", to: "working" });
  });

  it("logSessionKilled writes correct event", () => {
    logSessionKilled(sessionsDir, "app-1", { reason: "user_requested" });

    const events = readEvents(sessionsDir, "app-1");
    expect(events[0].event).toBe("session.killed");
    expect(events[0].data["reason"]).toBe("user_requested");
  });

  it("logSessionRestored writes correct event", () => {
    logSessionRestored(sessionsDir, "app-1", { previousStatus: "killed", runtimeId: "tmux-2" });

    const events = readEvents(sessionsDir, "app-1");
    expect(events[0].event).toBe("session.restored");
    expect(events[0].data["previousStatus"]).toBe("killed");
  });

  it("logSessionError writes correct event", () => {
    logSessionError(sessionsDir, "app-1", {
      error: "Something went wrong",
      context: "spawn",
    });

    const events = readEvents(sessionsDir, "app-1");
    expect(events[0].event).toBe("session.error");
    expect(events[0].data["error"]).toBe("Something went wrong");
  });
});

describe("isolation", () => {
  it("events for different sessions are independent", () => {
    appendEvent(sessionsDir, "app-1", "session.created", {});
    appendEvent(sessionsDir, "app-2", "session.created", {});
    appendEvent(sessionsDir, "app-1", "session.started", {});

    const events1 = readEvents(sessionsDir, "app-1");
    const events2 = readEvents(sessionsDir, "app-2");

    expect(events1).toHaveLength(2);
    expect(events2).toHaveLength(1);
  });
});

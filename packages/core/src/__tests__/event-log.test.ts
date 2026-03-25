import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createEventLog, createNullEventLog } from "../event-log.js";
import type { EventLogEntry } from "../event-log.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-event-log-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createEventLog", () => {
  it("creates the log file and appends JSONL entries", () => {
    const logPath = join(tmpDir, "events.jsonl");
    const log = createEventLog(logPath);

    const entry: EventLogEntry = {
      timestamp: "2026-03-25T00:00:00.000Z",
      type: "ci.failing",
      sessionId: "app-1",
      projectId: "my-app",
      message: "CI is failing",
      data: { oldStatus: "pr_open", newStatus: "ci_failed" },
    };

    log.append(entry);
    log.close();

    expect(existsSync(logPath)).toBe(true);

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]) as EventLogEntry;
    expect(parsed.type).toBe("ci.failing");
    expect(parsed.sessionId).toBe("app-1");
    expect(parsed.projectId).toBe("my-app");
    expect(parsed.message).toBe("CI is failing");
    expect(parsed.data).toEqual({ oldStatus: "pr_open", newStatus: "ci_failed" });
  });

  it("appends multiple entries in order", () => {
    const logPath = join(tmpDir, "events.jsonl");
    const log = createEventLog(logPath);

    log.append({
      timestamp: "2026-03-25T00:00:01.000Z",
      type: "session.working",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log.append({
      timestamp: "2026-03-25T00:00:02.000Z",
      type: "ci.failing",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log.append({
      timestamp: "2026-03-25T00:00:03.000Z",
      type: "reaction.triggered",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log.close();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const types = lines.map((l) => (JSON.parse(l) as EventLogEntry).type);
    expect(types).toEqual(["session.working", "ci.failing", "reaction.triggered"]);
  });

  it("creates parent directory if it does not exist", () => {
    const logPath = join(tmpDir, "subdir", "events.jsonl");
    const log = createEventLog(logPath);

    log.append({
      timestamp: new Date().toISOString(),
      type: "session.working",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log.close();

    expect(existsSync(logPath)).toBe(true);
  });

  it("appends to existing file (does not overwrite)", () => {
    const logPath = join(tmpDir, "events.jsonl");

    const log1 = createEventLog(logPath);
    log1.append({
      timestamp: "2026-03-25T00:00:01.000Z",
      type: "session.working",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log1.close();

    // Open a second time — should append, not overwrite
    const log2 = createEventLog(logPath);
    log2.append({
      timestamp: "2026-03-25T00:00:02.000Z",
      type: "ci.failing",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log2.close();

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("writes valid JSON for every line", () => {
    const logPath = join(tmpDir, "events.jsonl");
    const log = createEventLog(logPath);

    for (let i = 0; i < 5; i++) {
      log.append({
        timestamp: new Date().toISOString(),
        type: "reaction.triggered",
        sessionId: `session-${i}`,
        projectId: "project",
        data: { attempt: i, nested: { value: true } },
      });
    }
    log.close();

    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(5);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("createNullEventLog", () => {
  it("does not throw when appending or closing", () => {
    const log = createNullEventLog();

    expect(() => {
      log.append({
        timestamp: new Date().toISOString(),
        type: "ci.failing",
        sessionId: "app-1",
        projectId: "my-app",
      });
      log.close();
    }).not.toThrow();
  });

  it("does not write any files", () => {
    const log = createNullEventLog();
    log.append({
      timestamp: new Date().toISOString(),
      type: "ci.failing",
      sessionId: "app-1",
      projectId: "my-app",
    });
    log.close();

    // Null log should write nothing
    const files = existsSync(tmpDir) ? readdirSync(tmpDir) : [];
    expect(files).toHaveLength(0);
  });
});

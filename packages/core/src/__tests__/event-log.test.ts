import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appendEvent,
  followEventLog,
  getEventLogPath,
  getRotatedEventLogPath,
  readEventLog,
  type OrchestratorConfig,
} from "../index.js";

let tempRoot: string;
let configPath: string;
let config: OrchestratorConfig;

beforeEach(() => {
  tempRoot = join(tmpdir(), `ao-event-log-test-${randomUUID()}`);
  mkdirSync(tempRoot, { recursive: true });
  configPath = join(tempRoot, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n", "utf-8");

  config = {
    configPath,
    port: 3000,
    readyThresholdMs: 300_000,
    power: { preventIdleSleep: false },
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "acme/my-app",
        path: join(tempRoot, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.AO_EVENT_LOG_MAX_BYTES;
});

describe("event-log append and read", () => {
  it("writes events to the configured path as newline-delimited JSON", () => {
    appendEvent(config, {
      kind: "transition",
      component: "lifecycle-manager",
      operation: "lifecycle.transition",
      projectId: "my-app",
      sessionId: "app-1",
      fromStatus: "spawning",
      toStatus: "working",
      reason: "task_in_progress",
    });

    const path = getEventLogPath(config);
    expect(existsSync(path)).toBe(true);
    const contents = readFileSync(path, "utf-8").trim();
    expect(contents.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(contents);
    expect(parsed.kind).toBe("transition");
    expect(parsed.projectId).toBe("my-app");
    expect(parsed.fromStatus).toBe("spawning");
    expect(parsed.toStatus).toBe("working");
    expect(typeof parsed.correlationId).toBe("string");
    expect(typeof parsed.ts).toBe("string");
  });

  it("filters by session, project, and kind", () => {
    appendEvent(config, {
      kind: "transition",
      component: "lifecycle-manager",
      operation: "lifecycle.transition",
      projectId: "my-app",
      sessionId: "app-1",
    });
    appendEvent(config, {
      kind: "probe",
      component: "lifecycle-manager",
      operation: "lifecycle.sync",
      projectId: "my-app",
      sessionId: "app-2",
    });
    appendEvent(config, {
      kind: "reaction",
      component: "lifecycle-manager",
      operation: "reaction.send-to-agent",
      projectId: "my-app",
      sessionId: "app-1",
    });

    const bySession = readEventLog(config, { sessionId: "app-1" });
    expect(bySession).toHaveLength(2);
    expect(bySession.every((e) => e.sessionId === "app-1")).toBe(true);

    const byKind = readEventLog(config, { kinds: ["probe"] });
    expect(byKind).toHaveLength(1);
    expect(byKind[0].kind).toBe("probe");

    const multi = readEventLog(config, { kinds: ["transition", "reaction"] });
    expect(multi).toHaveLength(2);
  });

  it("filters by correlation id", () => {
    appendEvent(config, {
      kind: "transition",
      component: "lifecycle-manager",
      operation: "lifecycle.transition",
      correlationId: "shared-123",
      sessionId: "app-1",
    });
    appendEvent(config, {
      kind: "reaction",
      component: "lifecycle-manager",
      operation: "reaction.notify",
      correlationId: "shared-123",
      sessionId: "app-1",
    });
    appendEvent(config, {
      kind: "transition",
      component: "lifecycle-manager",
      operation: "lifecycle.transition",
      correlationId: "other-id",
      sessionId: "app-2",
    });

    const results = readEventLog(config, { correlationId: "shared-123" });
    expect(results).toHaveLength(2);
    expect(results.every((e) => e.correlationId === "shared-123")).toBe(true);
  });

  it("filters by sinceEpochMs", () => {
    appendEvent(config, {
      kind: "transition",
      component: "lifecycle-manager",
      operation: "lifecycle.transition",
    });
    const cutoff = Date.now() + 100;
    // spin to advance the clock a few ms to avoid ISO collision within resolution
    const start = Date.now();
    while (Date.now() - start < 120) {
      // wait
    }
    appendEvent(config, {
      kind: "probe",
      component: "lifecycle-manager",
      operation: "lifecycle.sync",
    });

    const results = readEventLog(config, { sinceEpochMs: cutoff });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((e) => Date.parse(e.ts) >= cutoff)).toBe(true);
  });

  it("applies limit by keeping the most recent matches", () => {
    for (let i = 0; i < 10; i++) {
      appendEvent(config, {
        kind: "probe",
        component: "lifecycle-manager",
        operation: "lifecycle.sync",
        data: { i },
      });
    }
    const results = readEventLog(config, { limit: 3 });
    expect(results).toHaveLength(3);
    // last in file = latest ts; limit keeps the tail.
    const iValues = results.map((e) => (e.data as { i: number }).i);
    expect(iValues).toEqual([7, 8, 9]);
  });

  it("redacts sensitive fields in data", () => {
    appendEvent(config, {
      kind: "reaction",
      component: "lifecycle-manager",
      operation: "reaction.send-to-agent",
      data: {
        token: "SECRET",
        apiKey: "sk-123",
        body: "should be redacted too",
        safe: "kept",
      },
    });
    const [entry] = readEventLog(config);
    expect((entry.data as Record<string, unknown>).token).toBe("[redacted]");
    expect((entry.data as Record<string, unknown>).apiKey).toBe("[redacted]");
    expect((entry.data as Record<string, unknown>).body).toBe("[redacted]");
    expect((entry.data as Record<string, unknown>).safe).toBe("kept");
  });

  it("rotates the log file when it exceeds the max size", () => {
    // Write ~6 KB of entries at a 4 KB limit so exactly one rotation is
    // triggered. Each entry is ~300 bytes; 20 entries ≈ 6 KB.
    process.env.AO_EVENT_LOG_MAX_BYTES = "4096";
    const filePath = getEventLogPath(config);
    for (let i = 0; i < 20; i++) {
      appendEvent(config, {
        kind: "probe",
        component: "lifecycle-manager",
        operation: "lifecycle.sync",
        data: {
          index: i,
          padding: "x".repeat(200),
        },
      });
    }

    const rotated = getRotatedEventLogPath(config);
    expect(existsSync(rotated)).toBe(true);
    // Current file stayed bounded (rotation is best-effort — we allow
    // overshoot by one entry's worth).
    const currentSize = statSync(filePath).size;
    expect(currentSize).toBeLessThan(2 * 4096);

    // Reads include both rotated and current file, recovering all entries.
    const all = readEventLog(config, { limit: 1000 });
    expect(all.length).toBe(20);
  });

  it("includes the rotated file when reading, unless asked not to", () => {
    process.env.AO_EVENT_LOG_MAX_BYTES = "512";
    for (let i = 0; i < 10; i++) {
      appendEvent(config, {
        kind: "probe",
        component: "lifecycle-manager",
        operation: "lifecycle.sync",
        data: { index: i, padding: "x".repeat(120) },
      });
    }
    const withRotated = readEventLog(config, { limit: 1000 });
    const withoutRotated = readEventLog(config, { limit: 1000, includeRotated: false });
    expect(withRotated.length).toBeGreaterThan(withoutRotated.length);
  });
});

describe("event-log follow", () => {
  it("emits each entry exactly once — no duplicates, no losses across backlog/tail boundary", async () => {
    // Write 5 entries before follow starts — all must appear as backlog.
    for (let i = 0; i < 5; i++) {
      appendEvent(config, {
        kind: "probe",
        component: "lifecycle-manager",
        operation: "lifecycle.sync",
        data: { tag: `pre-${i}` },
      });
    }

    const received: string[] = [];
    const handle = followEventLog(
      config,
      (entry) => {
        received.push((entry.data as { tag: string }).tag);
      },
      { limit: 50 },
    );

    try {
      // Append more after follow has captured the snapshot; these must all
      // be picked up by the tail, each exactly once.
      for (let i = 0; i < 5; i++) {
        appendEvent(config, {
          kind: "probe",
          component: "lifecycle-manager",
          operation: "lifecycle.sync",
          data: { tag: `post-${i}` },
        });
      }
      await new Promise((r) => setTimeout(r, 1200));

      // Every tag present exactly once.
      const counts = new Map<string, number>();
      for (const tag of received) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      for (let i = 0; i < 5; i++) {
        expect(counts.get(`pre-${i}`) ?? 0).toBe(1);
        expect(counts.get(`post-${i}`) ?? 0).toBe(1);
      }
    } finally {
      handle.stop();
    }
  });

  it("emits backlog and new entries appended after start", async () => {
    appendEvent(config, {
      kind: "probe",
      component: "lifecycle-manager",
      operation: "lifecycle.sync",
      data: { tag: "backlog" },
    });

    const received: string[] = [];
    const handle = followEventLog(
      config,
      (entry) => {
        received.push((entry.data as { tag: string }).tag);
      },
      { limit: 10 },
    );

    try {
      // Tick the event loop and then append.
      await new Promise((r) => setTimeout(r, 30));
      appendEvent(config, {
        kind: "transition",
        component: "lifecycle-manager",
        operation: "lifecycle.transition",
        data: { tag: "new" },
      });

      // Wait for the watch / poll to pick it up (poll runs every 1s).
      await new Promise((r) => setTimeout(r, 1200));
      expect(received).toContain("backlog");
      expect(received).toContain("new");
    } finally {
      handle.stop();
    }
  });
});

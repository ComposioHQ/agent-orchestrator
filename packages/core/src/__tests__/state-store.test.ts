import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  StateStore,
  createStateStore,
  migrateFromMetadata,
  migrateAllProjects,
  getStateDir,
  getEventsFilePath,
  hasStateStore,
  type SessionEvent,
  type SessionState,
} from "../state-store.js";
import { writeMetadata } from "../metadata.js";
import {
  getSessionsDir,
  getProjectBaseDir,
  generateProjectId,
  generateConfigHash,
} from "../paths.js";
import type { SessionStatus } from "../types.js";

describe("StateStore", () => {
  let tmpDir: string;
  let configPath: string;
  let projectPath: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ao-test-state-store-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });

    configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n");

    projectPath = join(tmpDir, "my-app");
    mkdirSync(projectPath, { recursive: true });

    store = createStateStore(configPath, projectPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("init() and basic operations", () => {
    it("creates state directory and initializes without error", () => {
      store.init();

      expect(store.isInitialized()).toBe(true);
      expect(existsSync(getStateDir(configPath, projectPath))).toBe(true);
    });

    it("returns empty state when file is new", () => {
      store.init();

      const state = store.getState();
      expect(state.size).toBe(0);
    });

    it("throws error if appendEvent called before init", () => {
      expect(() => {
        store.appendEvent({
          timestamp: Date.now(),
          sessionId: "app-1",
          projectId: "my-app",
          status: "working",
        });
      }).toThrow("StateStore not initialized");
    });
  });

  describe("appendEvent()", () => {
    beforeEach(async () => {
      await store.init();
    });

    it("appends a single event to the jsonl file", () => {
      const event: SessionEvent = {
        timestamp: 1712300000,
        sessionId: "app-1",
        projectId: "my-app",
        status: "working",
        metadata: { branch: "feat/test" },
      };

      store.appendEvent(event);

      const content = readFileSync(getEventsFilePath(configPath, projectPath), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionId).toBe("app-1");
      expect(parsed.status).toBe("working");
    });

    it("updates in-memory state after append", () => {
      const event: SessionEvent = {
        timestamp: 1712300000,
        sessionId: "app-1",
        projectId: "my-app",
        status: "working",
      };

      store.appendEvent(event);

      const state = store.getSessionState("app-1");
      expect(state).toBeDefined();
      expect(state?.status).toBe("working");
      expect(state?.sessionId).toBe("app-1");
    });

    it("appends multiple events and preserves order", () => {
      for (let i = 0; i < 5; i++) {
        store.appendEvent({
          timestamp: 1712300000 + i,
          sessionId: `app-${i + 1}`,
          projectId: "my-app",
          status: "working",
        });
      }

      const content = readFileSync(getEventsFilePath(configPath, projectPath), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      expect(lines.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        const parsed = JSON.parse(lines[i]);
        expect(parsed.sessionId).toBe(`app-${i + 1}`);
      }
    });
  });

  describe("hydrateState()", () => {
    it("reconstructs state from existing jsonl file", () => {
      const eventsFile = getEventsFilePath(configPath, projectPath);
      mkdirSync(join(tmpDir, "my-app"), { recursive: true });
      const stateDir = getStateDir(configPath, projectPath);
      mkdirSync(stateDir, { recursive: true });

      const events: SessionEvent[] = [
        { timestamp: 1712300000, sessionId: "app-1", projectId: "my-app", status: "working" },
        { timestamp: 1712300001, sessionId: "app-2", projectId: "my-app", status: "spawning" },
        { timestamp: 1712300002, sessionId: "app-1", projectId: "my-app", status: "pr_open" },
      ];

      for (const event of events) {
        appendFileSync(eventsFile, JSON.stringify(event) + "\n", "utf-8");
      }

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(2);

      const app1State = state.get("app-1");
      expect(app1State?.status).toBe("pr_open");
      expect(app1State?.lastUpdated).toBe(1712300002);

      const app2State = state.get("app-2");
      expect(app2State?.status).toBe("spawning");
    });
  });

  describe("1. The Concurrency Hammer", () => {
    beforeEach(async () => {
      await store.init();
    });

    it("handles 100 concurrent appendEvent calls without corruption", async () => {
      const numEvents = 100;
      const timestamps = Array.from({ length: numEvents }, (_, i) => 1712300000 + i);

      const appendPromises = timestamps.map((ts, i) => {
        return Promise.resolve().then(() => {
          store.appendEvent({
            timestamp: ts,
            sessionId: `app-${i + 1}`,
            projectId: "my-app",
            status: "working",
          });
        });
      });

      await Promise.all(appendPromises);

      const content = readFileSync(getEventsFilePath(configPath, projectPath), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      expect(lines.length).toBe(numEvents);

      const validJsonCount = lines.filter((line) => {
        try {
          JSON.parse(line);
          return true;
        } catch {
          return false;
        }
      }).length;

      expect(validJsonCount).toBe(numEvents);

      const sessionIds = lines
        .map((line) => JSON.parse(line).sessionId)
        .sort((a, b) => a.localeCompare(b));
      const expectedSessionIds = Array.from({ length: numEvents }, (_, i) => `app-${i + 1}`).sort(
        (a, b) => a.localeCompare(b),
      );
      expect(sessionIds).toEqual(expectedSessionIds);
    });
  });

  describe("2. The Compaction Squish", () => {
    beforeEach(async () => {
      await store.init();
    });

    it("compacts log to keep only latest state per session", () => {
      const statuses: SessionStatus[] = ["spawning", "working", "errored", "working", "done"];

      for (let i = 0; i < statuses.length; i++) {
        store.appendEvent({
          timestamp: 1712300000 + i,
          sessionId: "app-1",
          projectId: "my-app",
          status: statuses[i],
          metadata: { attempt: i + 1 },
        });
      }

      store.compactLog();

      const content = readFileSync(getEventsFilePath(configPath, projectPath), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      expect(lines.length).toBe(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.sessionId).toBe("app-1");
      expect(parsed.status).toBe("done");

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(1);

      const app1State = state.get("app-1");
      expect(app1State?.status).toBe("done");
    });

    it("compacts multiple sessions correctly", () => {
      store.appendEvent({
        timestamp: 1,
        sessionId: "app-1",
        projectId: "my-app",
        status: "working",
      });
      store.appendEvent({
        timestamp: 2,
        sessionId: "app-2",
        projectId: "my-app",
        status: "working",
      });
      store.appendEvent({ timestamp: 3, sessionId: "app-1", projectId: "my-app", status: "done" });
      store.appendEvent({ timestamp: 4, sessionId: "app-2", projectId: "my-app", status: "done" });

      store.compactLog();

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(2);
      expect(state.get("app-1")?.status).toBe("done");
      expect(state.get("app-2")?.status).toBe("done");
    });
  });

  describe("3. The Corrupt Tail Recovery", () => {
    beforeEach(async () => {
      await store.init();
    });

    it("gracefully drops truncated JSON at end of file", () => {
      store.appendEvent({
        timestamp: 1712300000,
        sessionId: "app-1",
        projectId: "my-app",
        status: "working",
      });
      store.appendEvent({
        timestamp: 1712300001,
        sessionId: "app-2",
        projectId: "my-app",
        status: "spawning",
      });

      const eventsFile = getEventsFilePath(configPath, projectPath);
      appendFileSync(
        eventsFile,
        '{"timestamp": 1712300002, "sessionId": "app-3", "status": "workin\n',
        "utf-8",
      );

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(2);
      expect(state.get("app-1")?.status).toBe("working");
      expect(state.get("app-2")?.status).toBe("spawning");
      expect(state.get("app-3")).toBeUndefined();
    });

    it("handles multiple corrupted lines", () => {
      store.appendEvent({
        timestamp: 1712300000,
        sessionId: "app-1",
        projectId: "my-app",
        status: "working",
      });

      const eventsFile = getEventsFilePath(configPath, projectPath);
      appendFileSync(eventsFile, 'invalid json\n{"truncated": true\n{"also broken', "utf-8");

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(1);
      expect(state.get("app-1")?.status).toBe("working");
    });

    it("handles empty file without error", () => {
      const eventsFile = getEventsFilePath(configPath, projectPath);
      writeFileSync(eventsFile, "", "utf-8");

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(0);
    });
  });

  describe("4. The Migration Pathway", () => {
    it("migrates from legacy metadata files to events.jsonl", () => {
      const sessionsDir = getSessionsDir(configPath, projectPath);
      mkdirSync(sessionsDir, { recursive: true });

      writeMetadata(sessionsDir, "app-1", {
        worktree: "/tmp/worktree1",
        branch: "feat/test",
        status: "working",
        project: "my-app",
        createdAt: "2025-01-01T00:00:00.000Z",
        agent: "claude-code",
      });

      writeMetadata(sessionsDir, "app-2", {
        worktree: "/tmp/worktree2",
        branch: "main",
        status: "done",
        project: "my-app",
        createdAt: "2025-01-02T00:00:00.000Z",
        agent: "claude-code",
      });

      const count = migrateFromMetadata(configPath, projectPath);

      expect(count).toBe(2);
      expect(hasStateStore(configPath, projectPath)).toBe(true);

      const freshStore = createStateStore(configPath, projectPath);
      freshStore.init();

      const state = freshStore.getState();
      expect(state.size).toBe(2);

      const app1State = state.get("app-1");
      expect(app1State?.status).toBe("working");
      expect(app1State?.metadata.worktree).toBe("/tmp/worktree1");

      const app2State = state.get("app-2");
      expect(app2State?.status).toBe("done");
    });

    it("migrateAllProjects migrates all projects in config", () => {
      const configFile = join(tmpDir, "agent-orchestrator.yaml");
      writeFileSync(
        configFile,
        `
projects:
  project-a:
    repo: org/a
    path: ${join(tmpDir, "project-a")}
  project-b:
    repo: org/b
    path: ${join(tmpDir, "project-b")}
`,
      );

      mkdirSync(join(tmpDir, "project-a"), { recursive: true });
      mkdirSync(join(tmpDir, "project-b"), { recursive: true });

      const sessionsDirA = getSessionsDir(configPath, join(tmpDir, "project-a"));
      mkdirSync(sessionsDirA, { recursive: true });
      writeMetadata(sessionsDirA, "app-1", {
        worktree: "/tmp/ws-a",
        branch: "main",
        status: "working",
        project: "project-a",
      });

      const sessionsDirB = getSessionsDir(configPath, join(tmpDir, "project-b"));
      mkdirSync(sessionsDirB, { recursive: true });
      writeMetadata(sessionsDirB, "app-2", {
        worktree: "/tmp/ws-b",
        branch: "main",
        status: "done",
        project: "project-b",
      });

      const results = migrateAllProjects(configPath);

      expect(results.length).toBe(2);
      expect(results.map((r) => r.projectId).sort()).toEqual(["project-a", "project-b"]);
    });

    it("migrateFromMetadata returns 0 when no sessions exist", () => {
      mkdirSync(join(tmpDir, "my-app"), { recursive: true });

      const count = migrateFromMetadata(configPath, projectPath);

      expect(count).toBe(0);
    });
  });

  describe("getStateDir and path utilities", () => {
    it("returns correct state directory path", () => {
      const stateDir = getStateDir(configPath, projectPath);
      expect(stateDir).toContain(".agent-orchestrator");
      expect(stateDir).toContain("state");
    });

    it("returns correct events file path", () => {
      const eventsPath = getEventsFilePath(configPath, projectPath);
      expect(eventsPath).toContain("events.jsonl");
    });
  });
});

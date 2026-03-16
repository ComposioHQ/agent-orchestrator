import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toGeminiProjectPath, create } from "../index.js";
import type { Session, RuntimeHandle } from "@composio/ao-core";

// Mock homedir() so getActivityState looks in our temp dir
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

let fakeHome: string;
let workspacePath: string;
let projectDir: string;

function makeSession(overrides: Partial<Session> = {}): Session {
  const handle: RuntimeHandle = { id: "test-1", runtimeName: "tmux", data: {} };
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "idle",
    branch: "main",
    issueId: null,
    pr: null,
    workspacePath,
    runtimeHandle: handle,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function writeJson(
  entries: Array<{ type: string; [key: string]: unknown }>,
  ageMs = 0,
  filename = "session-abc.json",
): void {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const filePath = join(projectDir, filename);
  writeFileSync(filePath, content);
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    utimesSync(filePath, past, past);
  }
}

// =============================================================================
// toGeminiProjectPath
// =============================================================================

describe("Gemini Activity Detection", () => {
  describe("toGeminiProjectPath", () => {
    it("returns a 64-character hex string (SHA-256)", () => {
      const result = toGeminiProjectPath("/Users/dev/.worktrees/ao");
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic — same path yields same hash", () => {
      const p = "/Users/dev/project";
      expect(toGeminiProjectPath(p)).toBe(toGeminiProjectPath(p));
    });

    it("different paths yield different hashes", () => {
      expect(toGeminiProjectPath("/path/a")).not.toBe(toGeminiProjectPath("/path/b"));
    });

    it("normalizes Windows backslashes before hashing", () => {
      // Forward and back slash should produce the same hash
      expect(toGeminiProjectPath("C:/Users/dev/project")).toBe(
        toGeminiProjectPath("C:\\Users\\dev\\project"),
      );
    });
  });

  // =============================================================================
  // getActivityState — integration tests with real JSON files on disk
  // =============================================================================

  describe("getActivityState", () => {
    const agent = create();

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), "ao-activity-test-"));
      workspacePath = join(fakeHome, "workspace");
      mkdirSync(workspacePath, { recursive: true });

      // Create the Gemini project directory: ~/.gemini/tmp/<sha256>/chats/
      const hash = toGeminiProjectPath(workspacePath);
      projectDir = join(fakeHome, ".gemini", "tmp", hash, "chats");
      mkdirSync(projectDir, { recursive: true });

      // Mock isProcessRunning to always return true (we test exited separately)
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);
    });

    afterEach(() => {
      rmSync(fakeHome, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // Process / handle edge cases
    // -----------------------------------------------------------------------

    it("returns 'exited' when process is not running", async () => {
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(false);
      writeJson([{ type: "assistant" }]);
      expect((await agent.getActivityState(makeSession()))?.state).toBe("exited");
    });

    it("returns 'exited' when no runtimeHandle", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: undefined })))?.state).toBe(
        "exited",
      );
    });

    it("returns 'exited' when runtimeHandle is null", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: null })))?.state).toBe("exited");
    });

    // -----------------------------------------------------------------------
    // Fallback cases (no JSON data available)
    // -----------------------------------------------------------------------

    it("returns null when no session file exists yet", async () => {
      // projectDir exists but is empty — no .json files
      expect(await agent.getActivityState(makeSession())).toBeNull();
    });

    it("returns null when no workspacePath", async () => {
      expect(await agent.getActivityState(makeSession({ workspacePath: null }))).toBeNull();
    });

    it("returns null when project directory does not exist", async () => {
      // Point to a workspace whose project dir doesn't exist
      const badPath = join(fakeHome, "nonexistent-workspace");
      expect(await agent.getActivityState(makeSession({ workspacePath: badPath }))).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Entry type handling
    // -----------------------------------------------------------------------

    describe("entry types", () => {
      it("returns 'active' for recent 'progress' entry (streaming)", async () => {
        writeJson([{ type: "progress", status: "running tool" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'active' for recent 'user' entry", async () => {
        writeJson([{ type: "user", message: { content: "fix the bug" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'ready' for recent 'assistant' entry", async () => {
        writeJson([{ type: "assistant", message: { content: "Done!" } }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'system' entry", async () => {
        writeJson([{ type: "system", summary: "session started" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'active' for recent 'tool_use' entry", async () => {
        writeJson([{ type: "tool_use" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("returns 'waiting_input' for 'permission_request'", async () => {
        writeJson([{ type: "permission_request" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });

      it("returns 'blocked' for 'error'", async () => {
        writeJson([{ type: "error" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("returns 'ready' for recent 'summary' entry", async () => {
        writeJson([{ type: "summary", summary: "Implemented login feature" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns 'ready' for recent 'result' entry", async () => {
        writeJson([{ type: "result" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });
    });

    // -----------------------------------------------------------------------
    // Staleness / threshold behavior
    // -----------------------------------------------------------------------

    describe("staleness threshold", () => {
      it("returns 'idle' for stale 'assistant' entry (> threshold)", async () => {
        writeJson([{ type: "assistant" }], 400_000); // 6+ min old
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'user' entry (> threshold)", async () => {
        writeJson([{ type: "user" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("returns 'idle' for stale 'progress' entry (> threshold)", async () => {
        writeJson([{ type: "progress" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });

      it("'permission_request' ignores staleness (always waiting_input)", async () => {
        writeJson([{ type: "permission_request" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("waiting_input");
      });

      it("'error' ignores staleness (always blocked)", async () => {
        writeJson([{ type: "error" }], 400_000);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("blocked");
      });

      it("respects custom readyThresholdMs", async () => {
        // 2 minutes old — stale with 60s threshold, ready with default 5min
        writeJson([{ type: "assistant" }], 120_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("ready");
      });

      it("custom threshold applies to active types too", async () => {
        // 2 minutes old
        writeJson([{ type: "user" }], 120_000);

        expect((await agent.getActivityState(makeSession(), 60_000))?.state).toBe("idle");
        expect((await agent.getActivityState(makeSession(), 300_000))?.state).toBe("active");
      });
    });

    // -----------------------------------------------------------------------
    // JSON file selection
    // -----------------------------------------------------------------------

    describe("JSON file selection", () => {
      it("picks the most recently modified JSON file", async () => {
        // Write an older file with "assistant" and a newer file with "user"
        writeJson([{ type: "assistant" }], 10_000, "old-session.json");
        writeJson([{ type: "user" }], 0, "new-session.json");

        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("ignores agent- prefixed JSON files", async () => {
        writeJson([{ type: "user" }], 0, "agent-toolkit.json");
        // No real session file → returns null (cannot determine activity)
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("reads last entry from multi-entry file (not first)", async () => {
        // First entry is user (active), last entry is assistant (ready)
        writeJson([
          { type: "user", message: { content: "fix bug" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Done!" } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("returns null for empty JSON file", async () => {
        writeFileSync(join(projectDir, "empty-session.json"), "");
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("returns null for file with only whitespace", async () => {
        writeFileSync(join(projectDir, "whitespace-session.json"), "\n\n  \n");
        expect(await agent.getActivityState(makeSession())).toBeNull();
      });

      it("ignores non-JSON files in project directory", async () => {
        // Write a non-JSON file
        writeFileSync(join(projectDir, "notes.txt"), "some notes");
        // Write actual session file
        writeJson([{ type: "assistant" }]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });
    });

    // -----------------------------------------------------------------------
    // Realistic session sequences
    // -----------------------------------------------------------------------

    describe("realistic session sequences", () => {
      it("detects agent mid-work (progress is last entry)", async () => {
        writeJson([
          { type: "user", message: { content: "implement auth" } },
          { type: "assistant", message: { content: "I'll implement..." } },
          { type: "progress", status: "Reading file" },
          { type: "progress", status: "Writing file" },
          { type: "progress", status: "Running tool" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("active");
      });

      it("detects agent done and waiting (assistant is last entry)", async () => {
        writeJson([
          { type: "user", message: { content: "implement auth" } },
          { type: "progress", status: "thinking" },
          { type: "progress", status: "writing" },
          { type: "assistant", message: { content: "I've implemented the auth feature." } },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects agent done with summary", async () => {
        writeJson([
          { type: "user", message: { content: "fix tests" } },
          { type: "progress", status: "thinking" },
          { type: "assistant", message: { content: "Fixed!" } },
          { type: "summary", summary: "Fixed failing tests" },
        ]);
        expect((await agent.getActivityState(makeSession()))?.state).toBe("ready");
      });

      it("detects stale finished session", async () => {
        writeJson(
          [
            { type: "user", message: { content: "implement auth" } },
            { type: "assistant", message: { content: "Done" } },
          ],
          600_000, // 10 min old
        );
        expect((await agent.getActivityState(makeSession()))?.state).toBe("idle");
      });
    });
  });
});

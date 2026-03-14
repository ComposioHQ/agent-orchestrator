import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toCursorProjectPath, create } from "../index.js";
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

function writeJsonl(
  entries: Array<{ type: string; [key: string]: unknown }>,
  ageMs = 0,
  filename = "session-abc.jsonl",
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
// toCursorProjectPath
// =============================================================================

describe("Claude Code Activity Detection", () => {
  describe("toCursorProjectPath", () => {
    it("encodes paths with leading dash", () => {
      expect(toCursorProjectPath("/Users/dev/.worktrees/ao")).toBe("-Users-dev--worktrees-ao");
    });

    it("preserves leading slash as leading dash", () => {
      expect(toCursorProjectPath("/tmp/test")).toBe("-tmp-test");
    });

    it("replaces dots with dashes", () => {
      expect(toCursorProjectPath("/path/to/.hidden")).toBe("-path-to--hidden");
    });

    it("handles Windows paths (no leading slash)", () => {
      expect(toCursorProjectPath("C:\\Users\\dev\\project")).toBe("C-Users-dev-project");
    });

    it("handles consecutive dots and slashes", () => {
      // /a/../b/./c → -a-  -- -b- - -c → -a----b---c
      expect(toCursorProjectPath("/a/../b/./c")).toBe("-a----b---c");
    });

    it("handles paths with multiple dot-directories", () => {
      expect(toCursorProjectPath("/Users/dev/.config/.local/share")).toBe(
        "-Users-dev--config--local-share",
      );
    });
  });

  // =============================================================================
  // getActivityState
  // =============================================================================

  describe("getActivityState", () => {
    const agent = create();

    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), "ao-activity-test-"));
      workspacePath = join(fakeHome, "workspace");
      mkdirSync(workspacePath, { recursive: true });

      // Create the project directory (though it won't be used anymore)
      const encoded = toCursorProjectPath(workspacePath);
      projectDir = join(fakeHome, ".cursor", "projects", encoded);
      mkdirSync(projectDir, { recursive: true });

      // Mock isProcessRunning to always return true (we test exited separately)
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(true);
    });

    afterEach(() => {
      rmSync(fakeHome, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    // Cursor stores sessions in SQLite at ~/.cursor/chats/, not JSONL files.
    // Session introspection is not yet implemented for Cursor.

    it("returns 'exited' when process is not running", async () => {
      vi.spyOn(agent, "isProcessRunning").mockResolvedValue(false);
      expect((await agent.getActivityState(makeSession()))?.state).toBe("exited");
    });

    it("returns 'exited' when no runtimeHandle", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: undefined })))?.state).toBe(
        "exited",
      );
    });

    it("returns 'exited' when runtimeHandle is null", async () => {
      expect((await agent.getActivityState(makeSession({ runtimeHandle: null })))?.state).toBe(
        "exited",
      );
    });

    it("returns null when process is running (SQLite introspection not implemented)", async () => {
      expect(await agent.getActivityState(makeSession())).toBeNull();
      expect(await agent.getActivityState(makeSession({ workspacePath: null }))).toBeNull();
      expect(await agent.getActivityState(makeSession({ workspacePath: "/some/path" }))).toBeNull();
    });
  });
});

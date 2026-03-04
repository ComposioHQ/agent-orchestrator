import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  readMetadata,
  readMetadataRaw,
  readArchivedMetadataRaw,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  listArchivedSessionIds,
  reserveSessionId,
} from "../metadata.js";

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `ao-test-metadata-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("writeMetadata + readMetadata", () => {
  it("writes and reads basic metadata", () => {
    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp/worktree",
      branch: "feat/test",
      status: "working",
    });

    const meta = readMetadata(dataDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.worktree).toBe("/tmp/worktree");
    expect(meta!.branch).toBe("feat/test");
    expect(meta!.status).toBe("working");
  });

  it("writes and reads optional fields", () => {
    writeMetadata(dataDir, "app-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "pr_open",
      issue: "https://linear.app/team/issue/INT-100",
      pr: "https://github.com/org/repo/pull/42",
      summary: "Implementing feature X",
      project: "my-app",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: '{"id":"tmux-1","runtimeName":"tmux"}',
    });

    const meta = readMetadata(dataDir, "app-2");
    expect(meta).not.toBeNull();
    expect(meta!.issue).toBe("https://linear.app/team/issue/INT-100");
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/42");
    expect(meta!.summary).toBe("Implementing feature X");
    expect(meta!.project).toBe("my-app");
    expect(meta!.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(meta!.runtimeHandle).toBe('{"id":"tmux-1","runtimeName":"tmux"}');
  });

  it("returns null for nonexistent session", () => {
    const meta = readMetadata(dataDir, "nonexistent");
    expect(meta).toBeNull();
  });

  it("produces key=value format matching bash scripts", () => {
    writeMetadata(dataDir, "app-3", {
      worktree: "/tmp/w",
      branch: "feat/INT-123",
      status: "working",
      issue: "https://linear.app/team/issue/INT-123",
    });

    const content = readFileSync(join(dataDir, "app-3"), "utf-8");
    expect(content).toContain("worktree=/tmp/w\n");
    expect(content).toContain("branch=feat/INT-123\n");
    expect(content).toContain("status=working\n");
    expect(content).toContain("issue=https://linear.app/team/issue/INT-123\n");
  });

  it("omits optional fields that are undefined", () => {
    writeMetadata(dataDir, "app-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    const content = readFileSync(join(dataDir, "app-4"), "utf-8");
    expect(content).not.toContain("issue=");
    expect(content).not.toContain("pr=");
    expect(content).not.toContain("summary=");
  });
});

describe("readMetadataRaw", () => {
  it("reads arbitrary key=value pairs", () => {
    writeFileSync(
      join(dataDir, "raw-1"),
      "worktree=/tmp/w\nbranch=main\ncustom_key=custom_value\n",
      "utf-8",
    );

    const raw = readMetadataRaw(dataDir, "raw-1");
    expect(raw).not.toBeNull();
    expect(raw!["worktree"]).toBe("/tmp/w");
    expect(raw!["custom_key"]).toBe("custom_value");
  });

  it("returns null for nonexistent session", () => {
    expect(readMetadataRaw(dataDir, "nope")).toBeNull();
  });

  it("handles comments and empty lines", () => {
    writeFileSync(
      join(dataDir, "raw-2"),
      "# This is a comment\n\nkey1=value1\n\n# Another comment\nkey2=value2\n",
      "utf-8",
    );

    const raw = readMetadataRaw(dataDir, "raw-2");
    expect(raw).toEqual({ key1: "value1", key2: "value2" });
  });

  it("handles values containing equals signs", () => {
    writeFileSync(
      join(dataDir, "raw-3"),
      'runtimeHandle={"id":"foo","data":{"key":"val"}}\n',
      "utf-8",
    );

    const raw = readMetadataRaw(dataDir, "raw-3");
    expect(raw!["runtimeHandle"]).toBe('{"id":"foo","data":{"key":"val"}}');
  });
});

describe("updateMetadata", () => {
  it("updates specific fields while preserving others", () => {
    writeMetadata(dataDir, "upd-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    updateMetadata(dataDir, "upd-1", {
      status: "working",
      pr: "https://github.com/org/repo/pull/1",
    });

    const meta = readMetadata(dataDir, "upd-1");
    expect(meta!.status).toBe("working");
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/1");
    expect(meta!.worktree).toBe("/tmp/w");
    expect(meta!.branch).toBe("main");
  });

  it("deletes keys set to empty string", () => {
    writeMetadata(dataDir, "upd-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      summary: "doing stuff",
    });

    updateMetadata(dataDir, "upd-2", { summary: "" });

    const raw = readMetadataRaw(dataDir, "upd-2");
    expect(raw!["summary"]).toBeUndefined();
    expect(raw!["status"]).toBe("working");
  });

  it("creates file if it does not exist", () => {
    updateMetadata(dataDir, "upd-3", { status: "new", branch: "test" });

    const raw = readMetadataRaw(dataDir, "upd-3");
    expect(raw).toEqual({ status: "new", branch: "test" });
  });

  it("ignores undefined values", () => {
    writeMetadata(dataDir, "upd-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    updateMetadata(dataDir, "upd-4", { status: "pr_open", summary: undefined });

    const meta = readMetadata(dataDir, "upd-4");
    expect(meta!.status).toBe("pr_open");
    expect(meta!.summary).toBeUndefined();
  });
});

describe("deleteMetadata", () => {
  it("deletes metadata file and archives it", () => {
    writeMetadata(dataDir, "del-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    deleteMetadata(dataDir, "del-1", true);

    expect(existsSync(join(dataDir, "del-1"))).toBe(false);
    const archiveDir = join(dataDir, "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const files = readdirSync(archiveDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^del-1_/);
  });

  it("deletes without archiving when archive=false", () => {
    writeMetadata(dataDir, "del-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    deleteMetadata(dataDir, "del-2", false);

    expect(existsSync(join(dataDir, "del-2"))).toBe(false);
    expect(existsSync(join(dataDir, "archive"))).toBe(false);
  });

  it("is a no-op for nonexistent session", () => {
    expect(() => deleteMetadata(dataDir, "nope")).not.toThrow();
  });
});

describe("readArchivedMetadataRaw", () => {
  it("reads the latest archived metadata for a session", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    writeFileSync(
      join(archiveDir, "app-1_2025-01-01T00-00-00-000Z"),
      "branch=old-branch\nstatus=killed\n",
    );
    writeFileSync(
      join(archiveDir, "app-1_2025-06-15T12-00-00-000Z"),
      "branch=new-branch\nstatus=killed\n",
    );

    const raw = readArchivedMetadataRaw(dataDir, "app-1");
    expect(raw).not.toBeNull();
    expect(raw!["branch"]).toBe("new-branch");
  });

  it("does not match archives of session IDs sharing a prefix", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // "app" should NOT match "app_v2_..." (belongs to session "app_v2")
    writeFileSync(
      join(archiveDir, "app_v2_2025-01-01T00-00-00-000Z"),
      "branch=wrong\nstatus=killed\n",
    );

    expect(readArchivedMetadataRaw(dataDir, "app")).toBeNull();
  });

  it("correctly matches when similar-prefix sessions coexist in archive", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    // Archive for "app" — timestamp starts with digit
    writeFileSync(
      join(archiveDir, "app_2025-06-15T12-00-00-000Z"),
      "branch=correct\nstatus=killed\n",
    );
    // Archive for "app_v2" — should not be matched by "app"
    writeFileSync(
      join(archiveDir, "app_v2_2025-01-01T00-00-00-000Z"),
      "branch=wrong\nstatus=killed\n",
    );

    const raw = readArchivedMetadataRaw(dataDir, "app");
    expect(raw).not.toBeNull();
    expect(raw!["branch"]).toBe("correct");

    const rawV2 = readArchivedMetadataRaw(dataDir, "app_v2");
    expect(rawV2).not.toBeNull();
    expect(rawV2!["branch"]).toBe("wrong");
  });

  it("returns null when no archive exists for session", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    writeFileSync(
      join(archiveDir, "other-session_2025-01-01T00-00-00-000Z"),
      "branch=main\nstatus=killed\n",
    );

    expect(readArchivedMetadataRaw(dataDir, "app-1")).toBeNull();
  });

  it("returns null when archive directory does not exist", () => {
    expect(readArchivedMetadataRaw(dataDir, "app-1")).toBeNull();
  });

  it("integrates with deleteMetadata archive", () => {
    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp/w",
      branch: "feat/test",
      status: "killed",
      issue: "TEST-1",
    });

    deleteMetadata(dataDir, "app-1", true);

    // Active metadata should be gone
    expect(readMetadataRaw(dataDir, "app-1")).toBeNull();

    // Archived metadata should be readable
    const archived = readArchivedMetadataRaw(dataDir, "app-1");
    expect(archived).not.toBeNull();
    expect(archived!["branch"]).toBe("feat/test");
    expect(archived!["issue"]).toBe("TEST-1");
  });
});

describe("atomic writes", () => {
  it("writeMetadata leaves no .tmp files behind", () => {
    writeMetadata(dataDir, "atomic-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    // Verify the actual file was written correctly
    const meta = readMetadata(dataDir, "atomic-1");
    expect(meta!.status).toBe("working");
  });

  it("updateMetadata leaves no .tmp files behind", () => {
    writeMetadata(dataDir, "atomic-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    updateMetadata(dataDir, "atomic-2", { status: "working" });

    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    const meta = readMetadata(dataDir, "atomic-2");
    expect(meta!.status).toBe("working");
  });

  it("concurrent writeMetadata calls do not produce corrupt files", () => {
    // Simulate rapid sequential writes (synchronous, so they serialize naturally,
    // but each individual write must be atomic — no partial content)
    for (let i = 0; i < 20; i++) {
      writeMetadata(dataDir, "atomic-3", {
        worktree: "/tmp/w",
        branch: `branch-${i}`,
        status: "working",
        summary: `iteration ${i}`,
      });
    }

    const meta = readMetadata(dataDir, "atomic-3");
    expect(meta).not.toBeNull();
    expect(meta!.branch).toBe("branch-19");
    expect(meta!.summary).toBe("iteration 19");

    // No leftover temp files
    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("restoredAt persistence", () => {
  it("roundtrips restoredAt through writeMetadata and readMetadata", () => {
    const now = new Date().toISOString();
    writeMetadata(dataDir, "restore-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      restoredAt: now,
    });

    const meta = readMetadata(dataDir, "restore-1");
    expect(meta).not.toBeNull();
    expect(meta!.restoredAt).toBe(now);
  });

  it("restoredAt is persisted in the key=value file", () => {
    const now = "2026-03-01T12:00:00.000Z";
    writeMetadata(dataDir, "restore-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      restoredAt: now,
    });

    const content = readFileSync(join(dataDir, "restore-2"), "utf-8");
    expect(content).toContain(`restoredAt=${now}`);
  });

  it("restoredAt is undefined when not set", () => {
    writeMetadata(dataDir, "restore-3", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const meta = readMetadata(dataDir, "restore-3");
    expect(meta!.restoredAt).toBeUndefined();
  });

  it("updateMetadata can set restoredAt on an existing session", () => {
    writeMetadata(dataDir, "restore-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const now = new Date().toISOString();
    updateMetadata(dataDir, "restore-4", { restoredAt: now });

    const meta = readMetadata(dataDir, "restore-4");
    expect(meta!.restoredAt).toBe(now);
  });
});

describe("listMetadata", () => {
  it("lists all session IDs", () => {
    writeMetadata(dataDir, "app-1", { worktree: "/tmp", branch: "a", status: "s" });
    writeMetadata(dataDir, "app-2", { worktree: "/tmp", branch: "b", status: "s" });
    writeMetadata(dataDir, "app-3", { worktree: "/tmp", branch: "c", status: "s" });

    const list = listMetadata(dataDir);
    expect(list).toHaveLength(3);
    expect(list.sort()).toEqual(["app-1", "app-2", "app-3"]);
  });

  it("excludes archive directory and dotfiles", () => {
    writeMetadata(dataDir, "app-1", { worktree: "/tmp", branch: "a", status: "s" });
    mkdirSync(join(dataDir, "archive"), { recursive: true });
    writeFileSync(join(dataDir, ".hidden"), "x", "utf-8");

    const list = listMetadata(dataDir);
    expect(list).toEqual(["app-1"]);
  });

  it("returns empty array when sessions dir does not exist", () => {
    const emptyDir = join(tmpdir(), `ao-test-empty-${randomUUID()}`);
    const list = listMetadata(emptyDir);
    expect(list).toEqual([]);
    // no cleanup needed since dir was never created
  });
});

describe("listArchivedSessionIds", () => {
  it("lists unique session IDs from archive directory", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    writeFileSync(join(archiveDir, "app-1_2025-01-01T00-00-00-000Z"), "status=killed\n");
    writeFileSync(join(archiveDir, "app-1_2025-06-01T00-00-00-000Z"), "status=killed\n");
    writeFileSync(join(archiveDir, "app-2_2025-03-01T00-00-00-000Z"), "status=done\n");

    const ids = listArchivedSessionIds(dataDir).sort();
    expect(ids).toEqual(["app-1", "app-2"]);
  });

  it("returns empty array when archive directory does not exist", () => {
    expect(listArchivedSessionIds(dataDir)).toEqual([]);
  });

  it("returns empty array when archive directory is empty", () => {
    mkdirSync(join(dataDir, "archive"), { recursive: true });
    expect(listArchivedSessionIds(dataDir)).toEqual([]);
  });

  it("skips files without underscore separator", () => {
    const archiveDir = join(dataDir, "archive");
    mkdirSync(archiveDir, { recursive: true });

    writeFileSync(join(archiveDir, "malformed-no-timestamp"), "status=killed\n");
    writeFileSync(join(archiveDir, "app-1_2025-01-01T00-00-00-000Z"), "status=killed\n");

    expect(listArchivedSessionIds(dataDir)).toEqual(["app-1"]);
  });

  it("integrates with deleteMetadata archive flow", () => {
    writeMetadata(dataDir, "sess-1", { worktree: "/tmp", branch: "a", status: "working" });
    writeMetadata(dataDir, "sess-2", { worktree: "/tmp", branch: "b", status: "working" });

    deleteMetadata(dataDir, "sess-1", true);
    deleteMetadata(dataDir, "sess-2", true);

    const archived = listArchivedSessionIds(dataDir).sort();
    expect(archived).toEqual(["sess-1", "sess-2"]);

    // Active list should be empty
    expect(listMetadata(dataDir)).toEqual([]);
  });
});

describe("metadata round-tripping with special characters", () => {
  it("preserves values containing equals signs", () => {
    writeMetadata(dataDir, "special-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      runtimeHandle: '{"id":"tmux-1","data":{"key":"a=b"}}',
    });

    const meta = readMetadata(dataDir, "special-1");
    expect(meta!.runtimeHandle).toBe('{"id":"tmux-1","data":{"key":"a=b"}}');
  });

  it("preserves URLs with query strings", () => {
    const prUrl = "https://github.com/org/repo/pull/42?expand=1";
    writeMetadata(dataDir, "special-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "pr_open",
      pr: prUrl,
    });

    const meta = readMetadata(dataDir, "special-2");
    expect(meta!.pr).toBe(prUrl);
  });

  it("preserves summaries with special characters", () => {
    const summary = 'Implementing OAuth2 with JWT tokens & PKCE flow (RFC 7636)';
    writeMetadata(dataDir, "special-3", {
      worktree: "/tmp/w",
      branch: "feat/auth",
      status: "working",
      summary,
    });

    const meta = readMetadata(dataDir, "special-3");
    expect(meta!.summary).toBe(summary);
  });

  it("round-trips all optional fields through write/read cycle", () => {
    const fullMetadata = {
      worktree: "/Users/dev/projects/my-app/worktrees/sess-1",
      branch: "feat/INT-1234-complex-feature",
      status: "pr_open",
      tmuxName: "a3b4c5d6-sess-1",
      issue: "https://linear.app/team/issue/INT-1234",
      pr: "https://github.com/org/repo/pull/99",
      summary: "Refactoring the session manager for better concurrency",
      project: "my-app",
      agent: "claude-code",
      createdAt: "2025-06-15T12:00:00.000Z",
      runtimeHandle: '{"id":"a3b4c5d6-sess-1","runtimeName":"tmux","data":{}}',
      restoredAt: "2025-06-16T08:30:00.000Z",
      role: "worker",
      dashboardPort: 3000,
      terminalWsPort: 14800,
      directTerminalWsPort: 14801,
    };

    writeMetadata(dataDir, "roundtrip-1", fullMetadata);
    const meta = readMetadata(dataDir, "roundtrip-1");

    expect(meta).not.toBeNull();
    expect(meta!.worktree).toBe(fullMetadata.worktree);
    expect(meta!.branch).toBe(fullMetadata.branch);
    expect(meta!.status).toBe(fullMetadata.status);
    expect(meta!.tmuxName).toBe(fullMetadata.tmuxName);
    expect(meta!.issue).toBe(fullMetadata.issue);
    expect(meta!.pr).toBe(fullMetadata.pr);
    expect(meta!.summary).toBe(fullMetadata.summary);
    expect(meta!.project).toBe(fullMetadata.project);
    expect(meta!.agent).toBe(fullMetadata.agent);
    expect(meta!.createdAt).toBe(fullMetadata.createdAt);
    expect(meta!.runtimeHandle).toBe(fullMetadata.runtimeHandle);
    expect(meta!.restoredAt).toBe(fullMetadata.restoredAt);
    expect(meta!.role).toBe(fullMetadata.role);
    expect(meta!.dashboardPort).toBe(fullMetadata.dashboardPort);
    expect(meta!.terminalWsPort).toBe(fullMetadata.terminalWsPort);
    expect(meta!.directTerminalWsPort).toBe(fullMetadata.directTerminalWsPort);
  });

  it("round-trips through archive: write → delete(archive) → readArchived", () => {
    writeMetadata(dataDir, "roundtrip-2", {
      worktree: "/tmp/w",
      branch: "feat/issue-42",
      status: "merged",
      pr: "https://github.com/org/repo/pull/42",
      summary: "Fixed authentication bug",
    });

    deleteMetadata(dataDir, "roundtrip-2", true);

    const archived = readArchivedMetadataRaw(dataDir, "roundtrip-2");
    expect(archived).not.toBeNull();
    expect(archived!["branch"]).toBe("feat/issue-42");
    expect(archived!["status"]).toBe("merged");
    expect(archived!["pr"]).toBe("https://github.com/org/repo/pull/42");
    expect(archived!["summary"]).toBe("Fixed authentication bug");
  });
});

describe("session ID validation", () => {
  it("rejects session IDs with path traversal", () => {
    expect(() => readMetadata(dataDir, "../etc/passwd")).toThrow("Invalid session ID");
  });

  it("rejects session IDs with slashes", () => {
    expect(() => readMetadata(dataDir, "foo/bar")).toThrow("Invalid session ID");
  });

  it("rejects empty session IDs", () => {
    expect(() => readMetadata(dataDir, "")).toThrow("Invalid session ID");
  });

  it("rejects session IDs with spaces", () => {
    expect(() => readMetadata(dataDir, "foo bar")).toThrow("Invalid session ID");
  });

  it("accepts valid session IDs with hyphens and underscores", () => {
    writeMetadata(dataDir, "valid-session_1", {
      worktree: "/tmp",
      branch: "main",
      status: "working",
    });
    const meta = readMetadata(dataDir, "valid-session_1");
    expect(meta).not.toBeNull();
  });
});

describe("reserveSessionId", () => {
  it("reserves a new session ID", () => {
    const reserved = reserveSessionId(dataDir, "reserve-1");
    expect(reserved).toBe(true);
    expect(existsSync(join(dataDir, "reserve-1"))).toBe(true);
  });

  it("returns false if session ID is already taken", () => {
    reserveSessionId(dataDir, "reserve-2");
    const second = reserveSessionId(dataDir, "reserve-2");
    expect(second).toBe(false);
  });

  it("creates parent directories if needed", () => {
    const nestedDir = join(dataDir, "nested", "sessions");
    const reserved = reserveSessionId(nestedDir, "reserve-3");
    expect(reserved).toBe(true);
    expect(existsSync(join(nestedDir, "reserve-3"))).toBe(true);
  });

  it("reserved file can be written to with updateMetadata", () => {
    reserveSessionId(dataDir, "reserve-4");
    updateMetadata(dataDir, "reserve-4", { status: "spawning", branch: "main" });

    const raw = readMetadataRaw(dataDir, "reserve-4");
    expect(raw).not.toBeNull();
    expect(raw!["status"]).toBe("spawning");
    expect(raw!["branch"]).toBe("main");
  });
});

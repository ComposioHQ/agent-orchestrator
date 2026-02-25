import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  readMetadata,
  readMetadataRaw,
  readArchivedMetadataRaw,
  readPlanBlob,
  writeMetadata,
  writePlanBlob,
  updateMetadata,
  updatePlanStatus,
  deleteMetadata,
  listMetadata,
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
      evidenceSchemaVersion: "1",
      evidenceDir: "/tmp/w/.ao/evidence/app-2",
      evidenceCommandLog: "/tmp/w/.ao/evidence/app-2/command-log.json",
      evidenceTestsRun: "/tmp/w/.ao/evidence/app-2/tests-run.json",
      evidenceChangedPaths: "/tmp/w/.ao/evidence/app-2/changed-paths.json",
      evidenceKnownRisks: "/tmp/w/.ao/evidence/app-2/known-risks.json",
      planId: "plan-1",
      planTaskId: "task-7",
      planTaskValidated: "true",
    });

    const meta = readMetadata(dataDir, "app-2");
    expect(meta).not.toBeNull();
    expect(meta!.issue).toBe("https://linear.app/team/issue/INT-100");
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/42");
    expect(meta!.summary).toBe("Implementing feature X");
    expect(meta!.project).toBe("my-app");
    expect(meta!.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(meta!.runtimeHandle).toBe('{"id":"tmux-1","runtimeName":"tmux"}');
    expect(meta!.evidenceSchemaVersion).toBe("1");
    expect(meta!.evidenceDir).toBe("/tmp/w/.ao/evidence/app-2");
    expect(meta!.evidenceCommandLog).toBe("/tmp/w/.ao/evidence/app-2/command-log.json");
    expect(meta!.evidenceTestsRun).toBe("/tmp/w/.ao/evidence/app-2/tests-run.json");
    expect(meta!.evidenceChangedPaths).toBe("/tmp/w/.ao/evidence/app-2/changed-paths.json");
    expect(meta!.evidenceKnownRisks).toBe("/tmp/w/.ao/evidence/app-2/known-risks.json");
    expect(meta!.planId).toBe("plan-1");
    expect(meta!.planTaskId).toBe("task-7");
    expect(meta!.planTaskValidated).toBe("true");
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

describe("plan blob persistence", () => {
  it("writes and reads a plan blob and updates metadata fields", () => {
    writeMetadata(dataDir, "plan-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const written = writePlanBlob(dataDir, "plan-1", {
      planId: "workplan",
      planVersion: 1,
      blob: {
        tasks: [{ id: "t1", title: "Implement feature" }],
      },
    });

    expect(written.planStatus).toBe("draft");
    expect(existsSync(join(dataDir, written.planPath))).toBe(true);

    const meta = readMetadata(dataDir, "plan-1");
    expect(meta!.planId).toBe("workplan");
    expect(meta!.planVersion).toBe(1);
    expect(meta!.planStatus).toBe("draft");
    expect(meta!.planPath).toBe(written.planPath);

    const readBack = readPlanBlob<{ tasks: Array<{ id: string; title: string }> }>(
      dataDir,
      "plan-1",
    );
    expect(readBack).not.toBeNull();
    expect(readBack!.blob.tasks).toHaveLength(1);
    expect(readBack!.blob.tasks[0].id).toBe("t1");
  });

  it("transitions plan status and persists it to metadata + blob", () => {
    writeMetadata(dataDir, "plan-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const initial = writePlanBlob(dataDir, "plan-2", {
      planId: "workplan",
      planVersion: 1,
      blob: { goal: "ship" },
    });

    const updated = updatePlanStatus(dataDir, "plan-2", "validated");
    expect(updated).not.toBeNull();
    expect(updated!.planStatus).toBe("validated");

    const meta = readMetadata(dataDir, "plan-2");
    expect(meta!.planStatus).toBe("validated");

    const onDisk = JSON.parse(readFileSync(join(dataDir, initial.planPath), "utf-8")) as {
      planStatus: string;
    };
    expect(onDisk.planStatus).toBe("validated");
  });

  it("supersedes prior plan artifact when writing a newer version", () => {
    writeMetadata(dataDir, "plan-3", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const v1 = writePlanBlob(dataDir, "plan-3", {
      planId: "workplan",
      planVersion: 1,
      planStatus: "validated",
      blob: { iteration: 1 },
    });

    const v2 = writePlanBlob(dataDir, "plan-3", {
      planId: "workplan",
      planVersion: 2,
      blob: { iteration: 2 },
    });

    const v1Disk = JSON.parse(readFileSync(join(dataDir, v1.planPath), "utf-8")) as {
      planStatus: string;
    };
    expect(v1Disk.planStatus).toBe("superseded");

    const meta = readMetadata(dataDir, "plan-3");
    expect(meta!.planVersion).toBe(2);
    expect(meta!.planStatus).toBe("draft");
    expect(meta!.planPath).toBe(v2.planPath);
  });

  it("remains backward compatible with legacy metadata files", () => {
    writeFileSync(
      join(dataDir, "legacy-1"),
      "worktree=/tmp/w\nbranch=main\nstatus=working\n",
      "utf-8",
    );

    const meta = readMetadata(dataDir, "legacy-1");
    expect(meta).not.toBeNull();
    expect(meta!.planId).toBeUndefined();
    expect(meta!.planVersion).toBeUndefined();
    expect(meta!.planStatus).toBeUndefined();
    expect(meta!.planPath).toBeUndefined();
    expect(readPlanBlob(dataDir, "legacy-1")).toBeNull();
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

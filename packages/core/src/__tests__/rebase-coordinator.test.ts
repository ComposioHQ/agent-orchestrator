import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Mock node:child_process — all git calls go through execFile
// ---------------------------------------------------------------------------
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mockExecFile }));

import {
  readWorkingFiles,
  triggerRebaseForSiblings,
} from "../rebase-coordinator.js";
import type { Session } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "app-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/app-1",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws-app-1",
    runtimeHandle: { id: "app-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

/** Queue a successful git result. */
function gitOk(stdout = ""): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) =>
      cb(null, { stdout, stderr: "" }),
  );
}

/** Queue a failed git result. */
function gitFail(message: string): void {
  mockExecFile.mockImplementationOnce(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
      cb(Object.assign(new Error(message), { stdout: "", stderr: message, code: 1 })),
  );
}

// ---------------------------------------------------------------------------
// readWorkingFiles
// ---------------------------------------------------------------------------

describe("readWorkingFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-rebase-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty set when .ao/working-files.jsonl does not exist", async () => {
    const result = await readWorkingFiles(tmpDir);
    expect(result.size).toBe(0);
  });

  it("parses file entries from JSONL", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(
      join(aoDir, "working-files.jsonl"),
      '{"file":"src/index.ts"}\n{"file":"src/utils.ts"}\n',
    );

    const result = await readWorkingFiles(tmpDir);
    expect(result.has("src/index.ts")).toBe(true);
    expect(result.has("src/utils.ts")).toBe(true);
    expect(result.size).toBe(2);
  });

  it("skips malformed JSONL lines", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(
      join(aoDir, "working-files.jsonl"),
      '{"file":"src/index.ts"}\nnot-valid-json\n{"file":"src/foo.ts"}\n',
    );

    const result = await readWorkingFiles(tmpDir);
    expect(result.size).toBe(2);
  });

  it("skips entries where file is not a string", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(
      join(aoDir, "working-files.jsonl"),
      '{"file":123}\n{"file":"valid.ts"}\n',
    );

    const result = await readWorkingFiles(tmpDir);
    expect(result.size).toBe(1);
    expect(result.has("valid.ts")).toBe(true);
  });

  it("skips blank lines", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(
      join(aoDir, "working-files.jsonl"),
      '\n{"file":"a.ts"}\n\n',
    );

    const result = await readWorkingFiles(tmpDir);
    expect(result.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// triggerRebaseForSiblings
// ---------------------------------------------------------------------------

describe("triggerRebaseForSiblings", () => {
  let tmpDir: string;
  let siblingDir: string;
  const sendMessage = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-rebase-merged-"));
    siblingDir = mkdtempSync(join(tmpdir(), "ao-rebase-sibling-"));
    mockExecFile.mockReset();
    sendMessage.mockReset();
    sendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(siblingDir, { recursive: true, force: true });
  });

  it("returns empty array when mergedSession has no workspacePath", async () => {
    const merged = makeSession({ workspacePath: null });
    const results = await triggerRebaseForSiblings(merged, [], "main", sendMessage);
    expect(results).toEqual([]);
  });

  it("returns empty array when merged session has no working files", async () => {
    // No .ao/working-files.jsonl written → empty set
    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);
    expect(results).toEqual([]);
  });

  it("skips sibling with no workspacePath", async () => {
    // Write merged files
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/a.ts"}\n');

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: null, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);
    expect(results).toEqual([]);
  });

  it("skips sibling when no file overlap", async () => {
    // Merged session touches src/a.ts
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/a.ts"}\n');

    // Sibling touches src/b.ts — no overlap
    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/b.ts"}\n');

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);
    expect(results).toEqual([]);
  });

  it("returns dirty_skip when sibling has uncommitted changes", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    // git status returns dirty output
    gitOk(" M src/shared.ts");

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("dirty_skip");
    expect(results[0]!.sessionId).toBe("app-2");
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("returns error when git status fails", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitFail("not a git repo");

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("error");
  });

  it("returns clean when rebase and push succeed", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitOk(""); // status — clean
    gitOk(""); // fetch
    gitOk(""); // rebase
    gitOk(""); // push --force-with-lease

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results).toHaveLength(1);
    expect(results[0]!.outcome).toBe("clean");
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![1]).toContain("Auto-rebased");
  });

  it("returns clean with push-failed note when push fails", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitOk("");   // status — clean
    gitOk("");   // fetch
    gitOk("");   // rebase
    gitFail("rejected"); // push fails

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results[0]!.outcome).toBe("clean");
    expect(sendMessage.mock.calls[0]![1]).toContain("Push failed");
  });

  it("returns conflict when rebase fails and sends diff", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitOk("");           // status — clean
    gitOk("");           // fetch
    gitFail("conflict"); // rebase fails
    gitOk("");           // rebase --abort
    gitOk("diff output here"); // diff

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results[0]!.outcome).toBe("conflict");
    expect(sendMessage.mock.calls[0]![1]).toContain("diff output here");
  });

  it("returns conflict with file list when diff is empty", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitOk("");  // status
    gitOk("");  // fetch
    gitFail("conflict"); // rebase
    gitOk("");  // abort
    gitOk("");  // diff — empty

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results[0]!.outcome).toBe("conflict");
    expect(sendMessage.mock.calls[0]![1]).toContain("src/shared.ts");
  });

  it("returns error when fetch fails", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    gitOk("");       // status — clean
    gitFail("network error"); // fetch fails

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.message).toContain("fetch failed");
  });

  it("catches exceptions thrown during sibling processing and records error outcome", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    // Clean status, fetch, rebase, push all succeed — but sendMessage throws
    gitOk("");  // status
    gitOk("");  // fetch
    gitOk("");  // rebase
    gitOk("");  // push
    sendMessage.mockRejectedValueOnce(new Error("network failure"));

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });

    // sendMessage throw is caught by safeSend (best-effort), so result is still clean
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);
    expect(results[0]!.outcome).toBe("clean");
  });

  it("records error outcome with String(err) when caught error is not an Error instance", async () => {
    const aoDir = join(tmpDir, ".ao");
    mkdirSync(aoDir, { recursive: true });
    writeFileSync(join(aoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    const siblingAoDir = join(siblingDir, ".ao");
    mkdirSync(siblingAoDir, { recursive: true });
    writeFileSync(join(siblingAoDir, "working-files.jsonl"), '{"file":"src/shared.ts"}\n');

    // git status returns a non-Error throw from execFile (hits String(err) path in runGit)
    // runGit catches it and returns exitCode 1 with empty stderr
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) =>
        cb("string-only error"),
    );

    const merged = makeSession({ workspacePath: tmpDir });
    const sibling = makeSession({ id: "app-2", workspacePath: siblingDir, branch: "feat/app-2" });
    const results = await triggerRebaseForSiblings(merged, [sibling], "main", sendMessage);

    // runGit converts the string error to exitCode 1 → git status "failed"
    expect(results[0]!.outcome).toBe("error");
    expect(results[0]!.message).toContain("git status failed");
  });
});

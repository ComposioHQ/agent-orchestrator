import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceHooksConfig } from "@composio/ao-core";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "./index.js";

interface HookFixture {
  rootDir: string;
  dataDir: string;
  sessionId: string;
  metadataPath: string;
  scriptPath: string;
}

interface HookRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const fixtureRoots: string[] = [];

function runHookScript(
  scriptPath: string,
  payload: object,
  env: NodeJS.ProcessEnv,
): Promise<HookRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(scriptPath, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

async function readMetadataMap(metadataPath: string): Promise<Record<string, string>> {
  const raw = await readFile(metadataPath, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

async function setupFixture(): Promise<HookFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), "ao-claude-hook-"));
  fixtureRoots.push(rootDir);

  const workspacePath = join(rootDir, "workspace");
  const dataDir = join(rootDir, "sessions");
  const sessionId = "proj-1";
  const metadataPath = join(dataDir, sessionId);

  await mkdir(workspacePath, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(metadataPath, "status=working\nbranch=feat/original\n", "utf-8");

  const agent = create();
  if (!agent.setupWorkspaceHooks) {
    throw new Error("Claude plugin does not expose setupWorkspaceHooks");
  }

  const hookConfig: WorkspaceHooksConfig = { dataDir, sessionId };
  await agent.setupWorkspaceHooks(workspacePath, hookConfig);

  return {
    rootDir,
    dataDir,
    sessionId,
    metadataPath,
    scriptPath: join(workspacePath, ".claude", "metadata-updater.sh"),
  };
}

afterEach(async () => {
  while (fixtureRoots.length > 0) {
    const root = fixtureRoots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

describe("metadata updater hook command normalization", () => {
  it("updates PR metadata when gh pr create is prefixed with cd &&", async () => {
    const fixture = await setupFixture();

    const payload = {
      tool_name: "Bash",
      tool_input: { command: "cd /tmp/repo && gh pr create --fill" },
      tool_response: "Created pull request:\nhttps://github.com/acme/project/pull/123",
      exit_code: 0,
    };

    const result = await runHookScript(fixture.scriptPath, payload, {
      ...process.env,
      AO_DATA_DIR: fixture.dataDir,
      AO_SESSION: fixture.sessionId,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");

    const meta = await readMetadataMap(fixture.metadataPath);
    expect(meta["pr"]).toBe("https://github.com/acme/project/pull/123");
    expect(meta["status"]).toBe("pr_open");
  });

  it("updates branch metadata when git checkout -b is prefixed with cd &&", async () => {
    const fixture = await setupFixture();

    const payload = {
      tool_name: "Bash",
      tool_input: { command: "cd /tmp/repo && git checkout -b feat/hook-branch" },
      tool_response: "",
      exit_code: 0,
    };

    const result = await runHookScript(fixture.scriptPath, payload, {
      ...process.env,
      AO_DATA_DIR: fixture.dataDir,
      AO_SESSION: fixture.sessionId,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");

    const meta = await readMetadataMap(fixture.metadataPath);
    expect(meta["branch"]).toBe("feat/hook-branch");
  });

  it("updates branch metadata when git switch -c is prefixed with cd &&", async () => {
    const fixture = await setupFixture();

    const payload = {
      tool_name: "Bash",
      tool_input: { command: "cd /tmp/repo && git switch -c feat/switch-branch" },
      tool_response: "",
      exit_code: 0,
    };

    const result = await runHookScript(fixture.scriptPath, payload, {
      ...process.env,
      AO_DATA_DIR: fixture.dataDir,
      AO_SESSION: fixture.sessionId,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");

    const meta = await readMetadataMap(fixture.metadataPath);
    expect(meta["branch"]).toBe("feat/switch-branch");
  });

  it("updates status metadata when gh pr merge is prefixed with cd ;", async () => {
    const fixture = await setupFixture();

    const payload = {
      tool_name: "Bash",
      tool_input: { command: 'cd "/tmp/repo with spaces"; gh pr merge --squash' },
      tool_response: "",
      exit_code: 0,
    };

    const result = await runHookScript(fixture.scriptPath, payload, {
      ...process.env,
      AO_DATA_DIR: fixture.dataDir,
      AO_SESSION: fixture.sessionId,
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");

    const meta = await readMetadataMap(fixture.metadataPath);
    expect(meta["status"]).toBe("merged");
  });
});

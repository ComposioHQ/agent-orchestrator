import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

const { mockExecFileSync, mockAccessSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockAccessSync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn, execFileSync: mockExecFileSync };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return { ...actual, accessSync: mockAccessSync };
});

import {
  create,
  detect,
  manifest,
  resetCursorCaches,
  default as defaultExport,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
  return {
    id: "proc-1",
    runtimeName: "process",
    data: pid !== undefined ? { pid } : {},
  };
}

function makeLaunchConfig(
  overrides: Partial<AgentLaunchConfig> = {},
): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") {
      return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = found ? `  444 ttys005  ${processName}` : "  444 ttys005  zsh";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected"));
  });
}

function encodeCursorProjectPath(workspacePath: string): string {
  return workspacePath.replace(/^[\\/]+/, "").replace(/[/.]/g, "-");
}

function hashCursorWorkspacePath(workspacePath: string): string {
  return createHash("md5").update(workspacePath).digest("hex");
}

async function createCursorStoreDb(params: {
  storeDbPath: string;
  chatId: string;
  title: string;
  model?: string;
  inputBlobChars?: number;
  userPrompt?: string;
  assistantText?: string;
}): Promise<void> {
  const {
    storeDbPath,
    chatId,
    title,
    model = "gpt-5.4-xhigh-fast",
    inputBlobChars = 12_000,
    userPrompt = "Implement Cursor parity",
    assistantText = "Done",
  } = params;

  const db = new DatabaseSync(storeDbPath);
  try {
    db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");

    const meta = Buffer.from(
      JSON.stringify({
        agentId: chatId,
        latestRootBlobId: "root-blob",
        name: title,
        lastUsedModel: model,
        createdAt: Date.now(),
      }),
      "utf-8",
    ).toString("hex");

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", meta);
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
      "input-context",
      Buffer.from("X".repeat(inputBlobChars), "utf-8"),
    );
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
      "user-message",
      Buffer.from(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: userPrompt }],
          providerOptions: { cursor: { requestId: "req-1" } },
        }),
        "utf-8",
      ),
    );
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
      "assistant-message",
      Buffer.from(
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "Thinking...",
              providerOptions: { cursor: { modelName: model } },
            },
            { type: "text", text: assistantText },
          ],
          providerOptions: { cursor: { modelName: model } },
        }),
        "utf-8",
      ),
    );
  } finally {
    db.close();
  }
}

async function writeCursorSessionFixture(params: {
  homeDir: string;
  workspacePath: string;
  chatId?: string;
  title?: string;
  model?: string;
  firstUserText?: string;
  assistantText?: string;
  inputBlobChars?: number;
  transcriptAgeMs?: number;
  workerLogAgeMs?: number;
  workerLogContent?: string;
  withTranscript?: boolean;
  withStore?: boolean;
}): Promise<{ chatId: string; transcriptPath: string; storeDbPath: string; workerLogPath: string }> {
  const {
    homeDir,
    workspacePath,
    chatId = "cursor-chat-1",
    title = "Cursor Fixer",
    model = "gpt-5.4-xhigh-fast",
    firstUserText = "Implement Cursor parity",
    assistantText = "Cursor parity is implemented.",
    inputBlobChars = 12_000,
    transcriptAgeMs = 0,
    workerLogAgeMs = 0,
    workerLogContent = "[info] Applying changes\n",
    withTranscript = true,
    withStore = true,
  } = params;

  const projectDir = join(homeDir, ".cursor", "projects", encodeCursorProjectPath(workspacePath));
  const transcriptPath = join(
    projectDir,
    "agent-transcripts",
    chatId,
    `${chatId}.jsonl`,
  );
  const workerLogPath = join(projectDir, "worker.log");
  const storeDbPath = join(
    homeDir,
    ".cursor",
    "chats",
    hashCursorWorkspacePath(workspacePath),
    chatId,
    "store.db",
  );

  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, "repo.json"), JSON.stringify({ id: "repo-1" }) + "\n", "utf-8");
  await writeFile(workerLogPath, workerLogContent, "utf-8");

  if (withTranscript) {
    await mkdir(join(projectDir, "agent-transcripts", chatId), { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: firstUserText }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [{ type: "text", text: assistantText }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
  }

  if (withStore) {
    await mkdir(join(homeDir, ".cursor", "chats", hashCursorWorkspacePath(workspacePath), chatId), {
      recursive: true,
    });
    await createCursorStoreDb({
      storeDbPath,
      chatId,
      title,
      model,
      inputBlobChars,
      userPrompt: firstUserText,
      assistantText,
    });
  }

  const now = Date.now();
  const transcriptTime = new Date(now - transcriptAgeMs);
  const workerTime = new Date(now - workerLogAgeMs);

  await utimes(workerLogPath, workerTime, workerTime);
  if (withTranscript) {
    await utimes(transcriptPath, transcriptTime, transcriptTime);
  }
  if (withStore) {
    await utimes(storeDbPath, transcriptTime, transcriptTime);
  }

  return { chatId, transcriptPath, storeDbPath, workerLogPath };
}

let homeDir = "";
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env["HOME"];
  originalPath = process.env["PATH"];
  homeDir = await mkdtemp(join(tmpdir(), "ao-cursor-home-"));
  process.env["HOME"] = homeDir;
  process.env["PATH"] = "/usr/bin:/bin";

  vi.clearAllMocks();
  resetCursorCaches();

  mockExecFileSync.mockImplementation(() => {
    throw new Error("missing");
  });
  mockAccessSync.mockImplementation(() => {
    throw new Error("missing");
  });
});

afterEach(async () => {
  resetCursorCaches();
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  if (originalPath === undefined) {
    delete process.env["PATH"];
  } else {
    process.env["PATH"] = originalPath;
  }
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "cursor",
      slot: "agent",
      description: "Agent plugin: Cursor Agent CLI",
      version: "0.1.1",
      displayName: "Cursor",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("cursor");
    expect(agent.processName).toBe("cursor-agent");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command with workspace", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'cursor-agent' --workspace '/workspace/repo'",
    );
  });

  it("includes --mode plan when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "suggest" }),
    );
    expect(cmd).toContain("--mode plan");
  });

  it("includes --force for permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless" }),
    );
    expect(cmd).toContain("--force");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("includes inline prompt as positional argument", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Fix the tests" }),
    );
    expect(cmd).toContain("'Fix the tests'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "suggest",
        model: "gpt-4o",
        prompt: "Go",
      }),
    );
    expect(cmd).toBe(
      "'cursor-agent' --workspace '/workspace/repo' --mode plan --model 'gpt-4o' 'Go'",
    );
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "it's broken" }),
    );
    expect(cmd).toContain("'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--mode");
    expect(cmd).not.toContain("--model");
  });

  it("combines systemPrompt with prompt into a single initial message", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "You are a helpful engineer",
        prompt: "Fix the bug",
      }),
    );
    expect(cmd).toContain("'You are a helpful engineer\n\nFix the bug'");
  });

  it("prefers systemPromptFile over inline systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "inline",
        systemPromptFile: "/tmp/prompt.txt",
        prompt: "do the task",
      }),
    );
    expect(cmd).toContain("$(cat '/tmp/prompt.txt'; printf '\\n\\n'; printf %s 'do the task')");
    expect(cmd).not.toContain("'inline'");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "skip" as unknown as AgentLaunchConfig["permissions"],
      }),
    );
    expect(cmd).toContain("--force");
  });

  it("includes --force for auto-edit", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "auto-edit" }),
    );
    expect(cmd).toContain("--force");
  });

  it("uses the cursor wrapper when cursor-agent is unavailable", () => {
    const wrapperAgent = create();

    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "which" && args?.[0] === "cursor-agent") {
        throw new Error("missing");
      }
      if (cmd === "which" && args?.[0] === "cursor") {
        return "/usr/local/bin/cursor\n";
      }
      throw new Error(`unexpected sync command: ${cmd} ${(args ?? []).join(" ")}`);
    });

    expect(wrapperAgent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'/usr/local/bin/cursor' agent --workspace '/workspace/repo'",
    );
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "LIN-99" }));
    expect(env["AO_ISSUE_ID"]).toBe("LIN-99");
  });

  it("prepends ~/.ao/bin and preferred gh bin to PATH", () => {
    process.env["PATH"] = "/opt/custom/bin:/usr/bin";
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toBe(`${join(homeDir, ".ao", "bin")}:/usr/local/bin:/opt/custom/bin:/usr/bin`);
    expect(env["GH_PATH"]).toBe("/usr/local/bin/gh");
  });

  it("passes through CURSOR_API_KEY from parent env", () => {
    process.env["CURSOR_API_KEY"] = "test-key-123";
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CURSOR_API_KEY"]).toBe("test-key-123");
  });

  it("passes through CURSOR_AUTH_TOKEN from parent env", () => {
    process.env["CURSOR_AUTH_TOKEN"] = "auth-token-456";
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CURSOR_AUTH_TOKEN"]).toBe("auth-token-456");
  });
});

// =========================================================================
// setupWorkspaceHooks
// =========================================================================
describe("setupWorkspaceHooks", () => {
  it("writes metadata wrappers and AGENTS.md context", async () => {
    const agent = create();
    const workspacePath = join(homeDir, "workspace", "repo");
    await mkdir(workspacePath, { recursive: true });

    await agent.setupWorkspaceHooks!(workspacePath, { dataDir: join(homeDir, ".ao-sessions") });

    const aoBinDir = join(homeDir, ".ao", "bin");
    expect(existsSync(join(aoBinDir, "ao-metadata-helper.sh"))).toBe(true);
    expect(existsSync(join(aoBinDir, "gh"))).toBe(true);
    expect(existsSync(join(aoBinDir, "git"))).toBe(true);

    const helper = await readFile(join(aoBinDir, "ao-metadata-helper.sh"), "utf-8");
    expect(helper).toContain("AO_DATA_DIR");
    expect(helper).toContain("AO_SESSION");

    const agentsMd = await readFile(join(workspacePath, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("Agent Orchestrator (ao) Session");
    expect(agentsMd).toContain("update_ao_metadata");
  });

  it("does not duplicate the AGENTS.md section", async () => {
    const agent = create();
    const workspacePath = join(homeDir, "workspace", "repo");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "AGENTS.md"), "# Existing\n", "utf-8");

    await agent.setupWorkspaceHooks!(workspacePath, { dataDir: join(homeDir, ".ao-sessions") });
    await agent.setupWorkspaceHooks!(workspacePath, { dataDir: join(homeDir, ".ao-sessions") });

    const agentsMd = await readFile(join(workspacePath, "AGENTS.md"), "utf-8");
    expect(agentsMd.match(/Agent Orchestrator \(ao\) Session/g)?.length ?? 0).toBe(1);
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when cursor found on tmux pane TTY", async () => {
    mockTmuxWithProcess("cursor-agent");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when cursor wrapper command found on tmux pane", async () => {
    mockTmuxWithProcess("cursor agent --prompt hello");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when cursor not on tmux pane TTY", async () => {
    mockTmuxWithProcess("cursor-agent", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("uses the shared ps cache across calls", async () => {
    mockTmuxWithProcess("cursor-agent");
    expect(await agent.isProcessRunning(makeTmuxHandle("pane-1"))).toBe(true);
    expect(await agent.isProcessRunning(makeTmuxHandle("pane-2"))).toBe(true);
    expect(
      mockExecFileAsync.mock.calls.filter(([cmd]) => cmd === "ps"),
    ).toHaveLength(1);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("cursor is processing files\n")).toBe("active");
  });

  it("returns idle when showing input prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns waiting_input for permission prompts", () => {
    expect(agent.detectActivity("Editing file.ts\nPermission required to write")).toBe("waiting_input");
  });

  it("returns waiting_input for yes/no prompts", () => {
    expect(agent.detectActivity("Apply changes?\n(y)es / (n)o")).toBe("waiting_input");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns ready when the latest transcript entry is assistant output", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-ready");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      workerLogAgeMs: 60_000,
      transcriptAgeMs: 2_000,
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        workspacePath,
        runtimeHandle: makeProcessHandle(123),
      }),
    );
    killSpy.mockRestore();

    expect(state?.state).toBe("ready");
  });

  it("returns active when worker.log is newer than the transcript", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-active");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      workerLogAgeMs: 500,
      transcriptAgeMs: 15_000,
      workerLogContent: "[info] Applying changes\n",
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        workspacePath,
        runtimeHandle: makeProcessHandle(123),
      }),
    );
    killSpy.mockRestore();

    expect(state?.state).toBe("active");
  });

  it("returns waiting_input when worker.log shows an approval prompt", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-waiting");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      workerLogContent: "MCP Server Approval Required\n[a] Approve all servers\n[c] Continue without approval\n",
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        workspacePath,
        runtimeHandle: makeProcessHandle(123),
      }),
    );
    killSpy.mockRestore();

    expect(state?.state).toBe("waiting_input");
  });

  it("returns blocked when worker.log ends with an error", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-blocked");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      workerLogContent: "[error] Request initialize failed with message: boom\n",
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        workspacePath,
        runtimeHandle: makeProcessHandle(123),
      }),
    );
    killSpy.mockRestore();

    expect(state?.state).toBe("blocked");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("extracts summary, chat id, and estimated cost from Cursor session files", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-info");
    const { chatId } = await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      chatId: "cursor-chat-42",
      title: "Cursor Metadata Fixer",
      model: "gpt-5.4-xhigh-fast",
      firstUserText: "Implement Cursor parity and metadata tracking",
      assistantText: "Implemented Cursor parity.",
      inputBlobChars: 16_000,
    });

    const info = await agent.getSessionInfo(makeSession({ workspacePath }));

    expect(info?.summary).toBe("Cursor Metadata Fixer");
    expect(info?.summaryIsFallback).toBe(false);
    expect(info?.agentSessionId).toBe(chatId);
    expect(info?.cost?.inputTokens).toBeGreaterThan(3000);
    expect(info?.cost?.outputTokens).toBeGreaterThan(1);
    expect(info?.cost?.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("falls back to the first user prompt when the title is generic", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-fallback");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      title: "New Agent",
      firstUserText: "Fix the broken restore flow for Cursor sessions",
    });

    const info = await agent.getSessionInfo(makeSession({ workspacePath }));
    expect(info?.summary).toBe("Fix the broken restore flow for Cursor sessions");
    expect(info?.summaryIsFallback).toBe(true);
  });

  it("returns null when no Cursor session artifacts exist", async () => {
    expect(
      await agent.getSessionInfo(makeSession({ workspacePath: join(homeDir, "workspace", "missing") })),
    ).toBeNull();
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  it("resumes the latest chat id with workspace, model, and permissions", async () => {
    const workspacePath = join(homeDir, "workspace", "repo-restore");
    await writeCursorSessionFixture({
      homeDir,
      workspacePath,
      chatId: "restore-chat-id",
      withTranscript: false,
      withStore: true,
    });

    const command = await agent.getRestoreCommand(
      makeSession({ workspacePath }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: workspacePath,
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: {
          permissions: "permissionless",
          model: "gpt-5.4-xhigh-fast",
        },
      },
    );

    expect(command).toBe(
      "'cursor-agent' --workspace '" +
        workspacePath +
        "' --resume 'restore-chat-id' --force --model 'gpt-5.4-xhigh-fast'",
    );
  });
});

// =========================================================================
// detect
// =========================================================================
describe("detect", () => {
  it("returns true when only the Cursor app bundle binary is available", () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "which" && (args?.[0] === "cursor-agent" || args?.[0] === "cursor")) {
        throw new Error("missing");
      }
      if (
        cmd === "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" &&
        args?.[0] === "agent" &&
        args?.[1] === "--version"
      ) {
        return "2026.03.25-933d5a6";
      }
      throw new Error(`unexpected sync command: ${cmd} ${(args ?? []).join(" ")}`);
    });

    mockAccessSync.mockImplementation((path: string) => {
      if (path === "/Applications/Cursor.app/Contents/Resources/app/bin/cursor") {
        return;
      }
      throw new Error("missing");
    });

    expect(detect()).toBe(true);
  });

  it("caches detect() results", () => {
    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === "which" && args?.[0] === "cursor-agent") {
        return "/usr/local/bin/cursor-agent\n";
      }
      if (cmd === "/usr/local/bin/cursor-agent" && args?.[0] === "--version") {
        return "2026.03.25-933d5a6";
      }
      throw new Error(`unexpected sync command: ${cmd} ${(args ?? []).join(" ")}`);
    });

    expect(detect()).toBe(true);
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });
});

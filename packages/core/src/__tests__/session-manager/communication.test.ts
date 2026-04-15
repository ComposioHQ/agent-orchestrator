import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../../metadata.js";
import type { OrchestratorConfig, PluginRegistry, Runtime, Agent } from "../../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "../test-utils.js";
import { installMockOpencode } from "./opencode-helpers.js";

let ctx: TestContext;
let tmpDir: string;
let sessionsDir: string;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;
let originalPath: string | undefined;

beforeEach(() => {
  ctx = setupTestContext();
  ({ tmpDir, sessionsDir, mockRuntime, mockAgent, mockRegistry, config, originalPath } = ctx);
  mkdirSync(join(tmpDir, "ws-app-1"), { recursive: true });
});

afterEach(() => {
  teardownTestContext(ctx);
});

function inboxFor(id: string) {
  return join(tmpDir, `comms-${id}`, "inbox");
}

function handleWithComms(id: string) {
  return makeHandle(id, { sessionsDir, sessionId: id, inboxPath: inboxFor(id) });
}

describe("send", () => {
  it("writes message to inbox JSONL file", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(handleWithComms("app-1")),
    });
    // Mock ALL runtime/agent calls to return alive+active, with changing output for delivery confirmation
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("agent output");
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "active", timestamp: new Date() });
    vi.mocked(mockAgent.detectActivity).mockReturnValue("active");

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.send("app-1", "Fix the CI failures");

    expect(existsSync(inboxFor("app-1"))).toBe(true);
    const content = readFileSync(inboxFor("app-1"), "utf-8");
    expect(content).toContain("Fix the CI failures");
    expect(content).toContain('"source":"orchestrator"');
  });

  it("resolves when delivery cannot be confirmed (message already written)", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: JSON.stringify(handleWithComms("app-1")),
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValue("steady output");
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);
    vi.mocked(mockAgent.detectActivity).mockReturnValue("idle");
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "idle" });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("app-1", "Fix the CI failures")).resolves.toBeUndefined();
    expect(existsSync(inboxFor("app-1"))).toBe(true);
  });

  it("throws for nonexistent session", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("nope", "hello")).rejects.toThrow("not found");
  });

  it("throws when handle has no inboxPath", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
    });
    vi.mocked(mockRuntime.getOutput).mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    vi.mocked(mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(mockAgent.isProcessRunning).mockResolvedValue(true);
    vi.mocked(mockAgent.getActivityState).mockResolvedValue({ state: "active" });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("app-1", "hello")).rejects.toThrow("missing inboxPath");
  });
});

describe("remap", () => {
  it("returns persisted OpenCode session id", async () => {
    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      opencodeSessionId: "ses_remap",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");
    expect(mapped).toBe("ses_remap");
  });

  it("discovers mapping by AO session title and persists it", async () => {
    const mockBin = installMockOpencode(
      tmpDir,
      JSON.stringify([{ id: "ses_discovered", title: "AO:app-1" }]),
      join(tmpDir, "opencode-delete.log"),
    );
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    const mapped = await sm.remap("app-1");
    expect(mapped).toBe("ses_discovered");
    expect(readMetadataRaw(sessionsDir, "app-1")?.["opencodeSessionId"]).toBe("ses_discovered");
  });

  it("throws when OpenCode session id mapping is missing", async () => {
    const mockBin = installMockOpencode(tmpDir, "[]", join(tmpDir, "opencode-delete.log"));
    process.env.PATH = `${mockBin}:${originalPath ?? ""}`;

    writeMetadata(sessionsDir, "app-1", {
      worktree: join(tmpDir, "ws-app-1"),
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: JSON.stringify(makeHandle("rt-1")),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.remap("app-1")).rejects.toThrow("mapping is missing");
  });
});

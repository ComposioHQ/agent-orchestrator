/**
 * TDD: workspace setup idempotency — bd-uxs.1
 *
 * setupWorkspaceHooks must NOT write files when content is already up-to-date.
 * Dirty-workspace bug: AO was re-writing .claude/settings.json and
 * metadata-updater.sh on every session setup, even when the content was
 * identical to what was already on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, statSync, utimesSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { create } from "../index.js";
import type { WorkspaceHooksConfig } from "@composio/ao-core";

let tmpDir: string;
let workspacePath: string;
let claudeDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-test-ws-"));
  workspacePath = join(tmpDir, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  claudeDir = join(workspacePath, ".claude");
  // Ensure MCP_AGENT_MAIL_URL is not set so setupMcpMailInWorkspace is a no-op
  delete process.env.MCP_AGENT_MAIL_URL;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeHookConfig(overrides: Partial<WorkspaceHooksConfig> = {}): WorkspaceHooksConfig {
  return {
    dataDir: join(tmpDir, "data"),
    ...overrides,
  };
}

/** Set a known old mtime on a file so we can detect whether it was written again. */
function setOldMtime(filePath: string): Date {
  const oldDate = new Date("2000-01-01T00:00:00Z");
  utimesSync(filePath, oldDate, oldDate);
  return oldDate;
}

function getMtime(filePath: string): number {
  return statSync(filePath).mtimeMs;
}

describe("setupWorkspaceHooks idempotency", () => {
  it("creates settings.json and metadata-updater.sh on first call", async () => {
    const agent = create();
    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig());

    const settingsPath = join(claudeDir, "settings.json");
    const scriptPath = join(claudeDir, "metadata-updater.sh");

    expect(() => statSync(settingsPath)).not.toThrow();
    expect(() => statSync(scriptPath)).not.toThrow();
  });

  it("does NOT re-write settings.json on second call when content is unchanged", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const settingsPath = join(claudeDir, "settings.json");
    const oldDate = setOldMtime(settingsPath);

    // Second call with identical config
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const mtimeAfter = getMtime(settingsPath);
    expect(mtimeAfter).toBe(oldDate.getTime());
  });

  it("does NOT re-write metadata-updater.sh on second call when content is unchanged", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const scriptPath = join(claudeDir, "metadata-updater.sh");
    const oldDate = setOldMtime(scriptPath);

    // Second call
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const mtimeAfter = getMtime(scriptPath);
    expect(mtimeAfter).toBe(oldDate.getTime());
  });

  it("DOES re-write settings.json when hook command changes (different dataDir)", async () => {
    const agent = create();

    // First call
    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig({ dataDir: join(tmpDir, "data-v1") }));

    const settingsPath = join(claudeDir, "settings.json");
    const oldDate = setOldMtime(settingsPath);

    // Second call with different dataDir → command changes → must write
    await agent.setupWorkspaceHooks!(workspacePath, makeHookConfig({ dataDir: join(tmpDir, "data-v2") }));

    const mtimeAfter = getMtime(settingsPath);
    expect(mtimeAfter).not.toBe(oldDate.getTime());
  });
});

describe("setupWorkspaceHooks with MCP mail idempotency", () => {
  beforeEach(() => {
    process.env.MCP_AGENT_MAIL_URL = "http://127.0.0.1:8765/mcp/";
  });

  afterEach(() => {
    delete process.env.MCP_AGENT_MAIL_URL;
  });

  it("does NOT re-write settings.json on second call when MCP mail config is unchanged", async () => {
    const agent = create();
    const hookConfig = makeHookConfig();

    // First call (writes hook + mcp-agent-mail config)
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const settingsPath = join(claudeDir, "settings.json");
    const oldDate = setOldMtime(settingsPath);

    // Second call — same URL, same hook — should be a no-op
    await agent.setupWorkspaceHooks!(workspacePath, hookConfig);

    const mtimeAfter = getMtime(settingsPath);
    expect(mtimeAfter).toBe(oldDate.getTime());
  });
});

describe("setupWorkspaceHooks symlink rejection", () => {
  it("throws when .claude dir is a symlink", async () => {
    // Create a target directory outside the workspace that an attacker controls
    const attackerDir = join(tmpDir, "attacker");
    mkdirSync(attackerDir, { recursive: true });

    // Replace .claude with a symlink pointing to the attacker directory
    symlinkSync(attackerDir, claudeDir);

    const agent = create();
    await expect(agent.setupWorkspaceHooks!(workspacePath, makeHookConfig())).rejects.toThrow(
      /symlink/i,
    );
  });
});

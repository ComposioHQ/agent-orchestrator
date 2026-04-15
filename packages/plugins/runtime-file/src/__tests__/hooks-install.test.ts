import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupComms } from "../index.js";

describe("setupComms (claude-code)", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "ao-hooks-install-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("creates .claude/ directory if missing", async () => {
    await setupComms(workspaceDir, { hooks: true });
    expect(existsSync(join(workspaceDir, ".claude"))).toBe(true);
  });

  it("writes all hook scripts", async () => {
    await setupComms(workspaceDir, { hooks: true });
    expect(existsSync(join(workspaceDir, ".claude", "ao-inbox-reader.sh"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".claude", "ao-stop-check.sh"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".claude", "ao-file-tracker.sh"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".claude", "ao-inbox-watcher.sh"))).toBe(true);
  });

  it("makes hook scripts executable", async () => {
    await setupComms(workspaceDir, { hooks: true });
    const scriptPath = join(workspaceDir, ".claude", "ao-inbox-reader.sh");
    const mode = statSync(scriptPath).mode;
    // Check owner execute bit (0o100)
    expect(mode & 0o100).toBe(0o100);
  });

  it("creates settings.json with all three hook events", async () => {
    await setupComms(workspaceDir, { hooks: true });
    const settingsPath = join(workspaceDir, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown[]>;

    expect(Array.isArray(hooks["PostToolUse"])).toBe(true);
    expect(Array.isArray(hooks["Stop"])).toBe(true);
    expect(Array.isArray(hooks["UserPromptSubmit"])).toBe(true);
  });

  it("settings.json contains correct command paths", async () => {
    await setupComms(workspaceDir, { hooks: true });
    const settings = JSON.parse(
      readFileSync(join(workspaceDir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, Array<Record<string, unknown>>>;

    const postToolUseHooks = hooks["PostToolUse"].flatMap((e) =>
      (e["hooks"] ?? []) as Array<Record<string, unknown>>,
    );
    const postToolUseCommands = postToolUseHooks.map((h) => h["command"]);
    expect(postToolUseCommands).toContain(".claude/ao-inbox-reader.sh");
    expect(postToolUseCommands).toContain(".claude/ao-inbox-watcher.sh");

    // Watcher must be registered as async + asyncRewake
    const watcherHook = postToolUseHooks.find((h) => h["command"] === ".claude/ao-inbox-watcher.sh");
    expect(watcherHook?.["async"]).toBe(true);
    expect(watcherHook?.["asyncRewake"]).toBe(true);

    const stopCommands = hooks["Stop"].flatMap((e) =>
      ((e["hooks"] ?? []) as Array<Record<string, unknown>>).map((h) => h["command"]),
    );
    expect(stopCommands).toContain(".claude/ao-stop-check.sh");

    const submitCommands = hooks["UserPromptSubmit"].flatMap((e) =>
      ((e["hooks"] ?? []) as Array<Record<string, unknown>>).map((h) => h["command"]),
    );
    expect(submitCommands).toContain(".claude/ao-inbox-reader.sh");
  });

  it("is idempotent — does not duplicate hooks on repeated calls", async () => {
    await setupComms(workspaceDir, { hooks: true });
    await setupComms(workspaceDir, { hooks: true });

    const settings = JSON.parse(
      readFileSync(join(workspaceDir, ".claude", "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    const hooks = settings["hooks"] as Record<string, unknown[]>;

    // Each hook event should only have one entry for our script
    const postToolUse = hooks["PostToolUse"] as Array<Record<string, unknown>>;
    const inboxReaderEntries = postToolUse.filter((e) => {
      const hs = (e["hooks"] ?? []) as Array<Record<string, unknown>>;
      return hs.some((h) => h["command"] === ".claude/ao-inbox-reader.sh");
    });
    expect(inboxReaderEntries).toHaveLength(1);
  });

  it("preserves existing hooks in settings.json", async () => {
    // Pre-populate settings with an existing hook (e.g. metadata-updater.sh)
    const claudeDir = join(workspaceDir, ".claude");
    const settingsPath = join(claudeDir, "settings.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: ".claude/metadata-updater.sh", timeout: 5000 }],
            },
          ],
        },
      }),
      "utf-8",
    );

    await setupComms(workspaceDir, { hooks: true });

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    const postToolUse = (settings["hooks"] as Record<string, unknown[]>)["PostToolUse"] as Array<Record<string, unknown>>;

    // Both the existing metadata-updater and our new inbox-reader should be present
    const commands = postToolUse.flatMap((e) =>
      ((e["hooks"] ?? []) as Array<Record<string, unknown>>).map((h) => h["command"]),
    );
    expect(commands).toContain(".claude/metadata-updater.sh");
    expect(commands).toContain(".claude/ao-inbox-reader.sh");
  });

  it("handles corrupt existing settings.json gracefully", async () => {
    const claudeDir = join(workspaceDir, ".claude");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{ not valid json }", "utf-8");

    // Should not throw — rewrites with fresh config
    await expect(setupComms(workspaceDir, { hooks: true })).resolves.toBeUndefined();

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(settings["hooks"]).toBeDefined();
  });
});

describe("setupComms flavors", () => {
  let workspaceDir: string;
  beforeEach(() => { workspaceDir = mkdtempSync(join(tmpdir(), "ao-flavors-")); });
  afterEach(() => { rmSync(workspaceDir, { recursive: true, force: true }); });

  it("codex flavor installs .codex/ hook scripts and generic watcher", async () => {
    await setupComms(workspaceDir, { flavors: ["codex"] });
    expect(existsSync(join(workspaceDir, ".codex", "ao-inbox-reader.sh"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".codex", "ao-stop-inbox.sh"))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(workspaceDir, ".codex", "hooks.json"), "utf-8"));
    expect(cfg.hooks.PostToolUse).toBeDefined();
    expect(cfg.hooks.Stop).toBeDefined();
    expect(existsSync(join(workspaceDir, ".ao", "ao-watcher.sh"))).toBe(true);
  });

  it("opencode flavor installs .opencode/plugin/ao-inbox.js (no watcher)", async () => {
    await setupComms(workspaceDir, { flavors: ["opencode"] });
    expect(existsSync(join(workspaceDir, ".opencode", "plugin", "ao-inbox.js"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".ao", "ao-watcher.sh"))).toBe(false);
  });

  it("cursor flavor installs sessionStart hook + AO_HOOK_FORMAT=cursor + watcher", async () => {
    await setupComms(workspaceDir, { flavors: ["cursor"] });
    const reader = readFileSync(join(workspaceDir, ".cursor", "ao-inbox-reader.sh"), "utf-8");
    expect(reader).toContain("AO_HOOK_FORMAT=cursor");
    const cfg = JSON.parse(readFileSync(join(workspaceDir, ".cursor", "hooks.json"), "utf-8"));
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.sessionStart).toBeDefined();
    expect(existsSync(join(workspaceDir, ".ao", "ao-watcher.sh"))).toBe(true);
  });

  it("aider flavor installs only the generic watcher", async () => {
    await setupComms(workspaceDir, { flavors: ["aider"] });
    expect(existsSync(join(workspaceDir, ".ao", "ao-watcher.sh"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".claude"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".codex"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".cursor"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".opencode"))).toBe(false);
  });

  it("empty flavors installs ao-emit only", async () => {
    await setupComms(workspaceDir, { flavors: [] });
    expect(existsSync(join(workspaceDir, ".ao", "ao-emit"))).toBe(true);
    expect(existsSync(join(workspaceDir, ".claude"))).toBe(false);
    expect(existsSync(join(workspaceDir, ".ao", "ao-watcher.sh"))).toBe(false);
  });
});

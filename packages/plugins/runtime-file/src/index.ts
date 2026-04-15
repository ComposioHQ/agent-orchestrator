import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { installAoEmit } from "./ao-emit.js";
import {
  getHookSettings,
  INBOX_READER_SCRIPT,
  STOP_INBOX_CHECK_SCRIPT,
  FILE_TRACKER_SCRIPT,
  INBOX_WATCHER_SCRIPT,
  CODEX_STOP_SCRIPT,
  GENERIC_WATCHER_SCRIPT,
  OPENCODE_PLUGIN_JS,
} from "./hooks.js";

export type Flavor = "claude-code" | "codex" | "opencode" | "cursor" | "aider";

export {
  resolveCommsFiles,
  createCommsFiles,
  removeCommsFiles,
  resetCursors,
  appendInboxMessage,
  appendMessage,
  readEpoch,
  writeEpoch,
  generateDedupKey,

  readNewMessages,
  watchDirectory,
  type SessionCommsFiles,
} from "./file-transport.js";
export { AGENT_EVENTS_FILE, type InboxMessageType } from "./message-types.js";
export { installAoEmit } from "./ao-emit.js";
export {
  getHookSettings,
  INBOX_READER_SCRIPT,
  STOP_INBOX_CHECK_SCRIPT,
  FILE_TRACKER_SCRIPT,
  INBOX_WATCHER_SCRIPT,
  CODEX_STOP_SCRIPT,
  GENERIC_WATCHER_SCRIPT,
  OPENCODE_PLUGIN_JS,
};

const HOOK_SCRIPTS: Array<{ file: string; content: string }> = [
  { file: "ao-inbox-reader.sh", content: INBOX_READER_SCRIPT },
  { file: "ao-stop-check.sh", content: STOP_INBOX_CHECK_SCRIPT },
  { file: "ao-file-tracker.sh", content: FILE_TRACKER_SCRIPT },
  { file: "ao-inbox-watcher.sh", content: INBOX_WATCHER_SCRIPT },
];

async function installClaudeHooks(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, ".claude");
  await mkdir(claudeDir, { recursive: true });

  for (const { file, content } of HOOK_SCRIPTS) {
    const scriptPath = join(claudeDir, file);
    await writeFile(scriptPath, content, "utf-8");
    await chmod(scriptPath, 0o755);
  }

  const settingsPath = join(claudeDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch { /* corrupt — start fresh */ }
  }

  const incoming = getHookSettings().hooks as Record<string, Array<Record<string, unknown>>>;
  const existing = (settings["hooks"] ?? {}) as Record<string, Array<unknown>>;

  for (const [event, entries] of Object.entries(incoming)) {
    const existingEntries = (existing[event] ?? []) as Array<Record<string, unknown>>;
    for (const entry of entries) {
      const hooks = (entry["hooks"] ?? []) as Array<Record<string, unknown>>;
      const command = hooks[0]?.["command"] as string | undefined;
      if (!command) continue;
      const already = existingEntries.some((e) =>
        ((e["hooks"] ?? []) as Array<Record<string, unknown>>).some((h) => h["command"] === command),
      );
      if (!already) existingEntries.push(entry);
    }
    existing[event] = existingEntries;
  }

  settings["hooks"] = existing;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

async function installCodexHooks(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, ".codex");
  await mkdir(dir, { recursive: true });
  const readerPath = join(dir, "ao-inbox-reader.sh");
  const stopPath = join(dir, "ao-stop-inbox.sh");
  await writeFile(readerPath, INBOX_READER_SCRIPT, "utf-8");
  await chmod(readerPath, 0o755);
  await writeFile(stopPath, CODEX_STOP_SCRIPT, "utf-8");
  await chmod(stopPath, 0o755);
  const config = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: readerPath }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: readerPath }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: readerPath }] }],
      Stop: [{ hooks: [{ type: "command", command: stopPath }] }],
    },
  };
  await writeFile(join(dir, "hooks.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

async function installOpenCodePlugin(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, ".opencode", "plugin");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ao-inbox.js"), OPENCODE_PLUGIN_JS, "utf-8");
}

async function installCursorHooks(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, ".cursor");
  await mkdir(dir, { recursive: true });
  const readerScript = INBOX_READER_SCRIPT.replace(
    "#!/usr/bin/env bash\nset -euo pipefail\n",
    "#!/usr/bin/env bash\nset -euo pipefail\nexport AO_HOOK_FORMAT=cursor\n",
  );
  const readerPath = join(dir, "ao-inbox-reader.sh");
  await writeFile(readerPath, readerScript, "utf-8");
  await chmod(readerPath, 0o755);
  const config = {
    version: 1,
    hooks: {
      sessionStart: [{ command: readerPath }],
    },
  };
  await writeFile(join(dir, "hooks.json"), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

async function installGenericWatcher(workspacePath: string): Promise<void> {
  const dir = join(workspacePath, ".ao");
  await mkdir(dir, { recursive: true });
  const watcherPath = join(dir, "ao-watcher.sh");
  await writeFile(watcherPath, GENERIC_WATCHER_SCRIPT, "utf-8");
  await chmod(watcherPath, 0o755);
}

const NEEDS_GENERIC_WATCHER: ReadonlySet<Flavor> = new Set(["codex", "cursor", "aider"]);

export async function setupComms(
  workspacePath: string,
  opts: { flavors?: Flavor[]; hooks?: boolean } = {},
): Promise<void> {
  await installAoEmit(workspacePath);
  const flavors: Flavor[] = opts.flavors ?? (opts.hooks ? ["claude-code"] : []);
  if (flavors.includes("claude-code")) await installClaudeHooks(workspacePath);
  if (flavors.includes("codex")) await installCodexHooks(workspacePath);
  if (flavors.includes("opencode")) await installOpenCodePlugin(workspacePath);
  if (flavors.includes("cursor")) await installCursorHooks(workspacePath);
  if (flavors.some((f) => NEEDS_GENERIC_WATCHER.has(f))) await installGenericWatcher(workspacePath);
}

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
} from "./hooks.js";

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
  initCounters,
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

export async function setupComms(workspacePath: string, { hooks = false }: { hooks?: boolean } = {}): Promise<void> {
  await installAoEmit(workspacePath);
  if (hooks) await installClaudeHooks(workspacePath);
}

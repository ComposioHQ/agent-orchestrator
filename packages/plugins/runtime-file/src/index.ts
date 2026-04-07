import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  RuntimeMetrics,
  AttachInfo,
  MessageInjector,
  PluginModule,
  PluginManifest,
} from "@composio/ao-core";
import {
  resolveCommsFiles,
  createCommsFiles,
  removeCommsFiles,
  resetCursors,
  appendInboxMessage,
  readEpoch,
  writeEpoch,
  generateDedupKey,
  initCounters,
  readNewMessages,
  watchDirectory,
  type SessionCommsFiles,
} from "./file-transport.js";
import {
  type InboxMessageType,
  resolveInjectionMode,
  AGENT_EVENTS_FILE,
} from "./message-types.js";
import {
  getHookSettings,
  INBOX_READER_SCRIPT,
  STOP_INBOX_CHECK_SCRIPT,
  PROMPT_INBOX_CHECK_SCRIPT,
  FILE_TRACKER_SCRIPT,
} from "./hooks.js";
import { AO_EMIT_SCRIPT, installAoEmit } from "./ao-emit.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export const manifest: PluginManifest = {
  name: "file",
  slot: "runtime" as const,
  description:
    "File-based communication runtime. Zero tmux in the communication path. " +
    "All agents spawned as subprocesses. Companion tmux session (tail -f) for terminal viewing only.",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const MAX_OUTPUT_LINES = 1000;
const TMUX_CMD_TIMEOUT_MS = 5_000;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

// ---------------------------------------------------------------------------
// Per-session state (no tmux dependency — pure subprocess)
// ---------------------------------------------------------------------------

interface SessionEntry {
  files: SessionCommsFiles;
  epoch: number;
  sessionsDir: string;
  sessionId: string;
  agentName: string;
  createdAt: number;
  outputBuffer: string[];
  process: ChildProcess | null;
  logStream: WriteStream | null;
  logPath: string;
  claudeSessionId: string;
  companionTmuxName: string | null;
  injector: MessageInjector | null;
}

// ---------------------------------------------------------------------------
// NDJSON message format for Claude Agent SDK stream-json protocol
// ---------------------------------------------------------------------------

function formatNdjsonUserMessage(content: string, sessionId = "default"): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

// ---------------------------------------------------------------------------
// Hook installation (Claude Code only)
// ---------------------------------------------------------------------------

const HOOK_SCRIPTS: Array<{ file: string; content: string }> = [
  { file: "ao-inbox-reader.sh", content: INBOX_READER_SCRIPT },
  { file: "ao-stop-check.sh", content: STOP_INBOX_CHECK_SCRIPT },
  { file: "ao-prompt-inbox.sh", content: PROMPT_INBOX_CHECK_SCRIPT },
  { file: "ao-file-tracker.sh", content: FILE_TRACKER_SCRIPT },
];

export async function installCommsHooks(workspacePath: string): Promise<void> {
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
      const alreadyInstalled = existingEntries.some((e) => {
        const eHooks = (e["hooks"] ?? []) as Array<Record<string, unknown>>;
        return eHooks.some((h) => h["command"] === command);
      });
      if (!alreadyInstalled) existingEntries.push(entry);
    }
    existing[event] = existingEntries;
  }

  settings["hooks"] = existing;
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Companion tmux session helpers (terminal viewing ONLY, not communication)
// ---------------------------------------------------------------------------

async function createCompanionTmux(
  sessionName: string,
  workspacePath: string,
  logPath: string,
): Promise<void> {
  try {
    await execFileAsync(
      "tmux",
      [
        "new-session", "-d",
        "-s", sessionName,
        "-c", workspacePath,
        `tail -f ${logPath}`,
      ],
      { timeout: TMUX_CMD_TIMEOUT_MS },
    );
  } catch {
    // Non-fatal: terminal viewing unavailable but communication works.
    console.warn(`[runtime-file] Failed to create companion tmux session "${sessionName}"`);
  }
}

async function destroyCompanionTmux(sessionName: string): Promise<void> {
  try {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName], {
      timeout: TMUX_CMD_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup.
  }
}

// ---------------------------------------------------------------------------
// Runtime implementation — all agents as subprocess, zero tmux communication
// ---------------------------------------------------------------------------

export function create(): Runtime {
  const sessions = new Map<string, SessionEntry>();
  let countersInitialized = false;

  return {
    name: "file",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const handleId = config.sessionId;
      const sessionsDir = config.environment.AO_DATA_DIR ?? "";

      if (!countersInitialized) {
        if (sessionsDir) {
          mkdirSync(sessionsDir, { recursive: true });
          initCounters(join(sessionsDir, ".message-counters.json"));
        }
        countersInitialized = true;
      }

      if (sessions.has(handleId)) {
        throw new Error(`Session "${handleId}" already exists`);
      }

      const agentName = config.environment.AO_AGENT_NAME ?? "";
      const files = resolveCommsFiles(sessionsDir, config.sessionId);
      createCommsFiles(files);

      // Always increment epoch (handles restore: distinguishes old vs new messages).
      let epoch = readEpoch(sessionsDir, config.sessionId);
      epoch += 1;
      writeEpoch(sessionsDir, config.sessionId, epoch);

      // Reset cursor files so agent re-reads from current position.
      resetCursors(files);

      // Set up log file for stdout/stderr capture.
      const logDir = join(config.workspacePath, ".ao");
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${handleId}.log`);
      const logStream = createWriteStream(logPath, { flags: "a" });

      const entry: SessionEntry = {
        files, epoch, sessionsDir, sessionId: config.sessionId,
        agentName, createdAt: Date.now(), outputBuffer: [],
        process: null, logStream, logPath,
        claudeSessionId: "default",
        companionTmuxName: handleId,
        injector: null,
      };
      sessions.set(handleId, entry);

      // Install Claude Code hooks before spawn (Claude Code only).
      const isClaudeCode = agentName === "claude-code";
      if (isClaudeCode) {
        try {
          await installCommsHooks(config.workspacePath);
        } catch (err) {
          console.warn(
            `[runtime-file] Failed to install comms hooks:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Install ao-emit script for ALL agents before spawn.
      try {
        await installAoEmit(config.workspacePath);
      } catch (err) {
        console.warn(
          `[runtime-file] Failed to install ao-emit script:`,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Transform launch command: use agent.getProgrammaticCommand if available,
      // otherwise fall back to built-in Claude Code detection.
      let launchCommand = config.agent?.getProgrammaticCommand
        ? config.agent.getProgrammaticCommand(config.launchCommand)
        : config.launchCommand;
      if (!config.agent?.getProgrammaticCommand && isClaudeCode &&
          launchCommand.includes("claude") && !launchCommand.includes("--input-format")) {
        launchCommand = launchCommand.replace(
          /\b(claude)\b/,
          "$1 -p --input-format stream-json --output-format stream-json --verbose",
        );
      }

      // Spawn subprocess with stdin pipe (ALL agents, zero tmux).
      let child: ChildProcess;
      try {
        child = spawn(launchCommand, {
          cwd: config.workspacePath,
          env: {
            ...process.env,
            ...config.environment,
            AO_INBOX_PATH: files.inbox,
            AO_AGENT_EVENTS_PATH: files.agentEvents,
          },
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
          detached: true,
        });
      } catch (err: unknown) {
        sessions.delete(handleId);
        logStream.end();
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to spawn for session ${handleId}: ${msg}`, { cause: err });
      }

      entry.process = child;

      child.on("error", (err) => {
        console.warn(`[runtime-file] Process error for session ${handleId}:`, err.message);
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          child.removeListener("spawn", onSpawn);
          sessions.delete(handleId);
          logStream.end();
          reject(new Error(`Failed to spawn for session ${handleId}: ${err.message}`));
        };
        const onSpawn = () => {
          child.removeListener("error", onError);
          resolve();
        };
        child.once("error", onError);
        child.once("spawn", onSpawn);
      });

      // Capture stdout/stderr to rolling buffer + log file.
      function makeAppendOutput(): (data: Buffer) => void {
        let partial = "";
        return (data: Buffer) => {
          const text = partial + data.toString("utf-8");
          const lines = text.split("\n");
          partial = lines.pop()!;
          for (const line of lines) {
            entry.outputBuffer.push(line);
            logStream.write(line + "\n");
            // Extract Claude session ID from stream-json init message.
            if (isClaudeCode && entry.claudeSessionId === "default" && line.trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed.type === "system" && parsed.subtype === "init" &&
                    typeof parsed.session_id === "string" && parsed.session_id) {
                  entry.claudeSessionId = parsed.session_id;
                }
              } catch { /* not JSON */ }
            }
          }
          if (entry.outputBuffer.length > MAX_OUTPUT_LINES) {
            entry.outputBuffer.splice(0, entry.outputBuffer.length - MAX_OUTPUT_LINES);
          }
        };
      }

      const appendStdout = makeAppendOutput();
      const appendStderr = makeAppendOutput();
      child.stdout?.on("data", appendStdout);
      child.stderr?.on("data", appendStderr);

      child.once("exit", () => {
        appendStdout(Buffer.from("\n"));
        appendStderr(Buffer.from("\n"));
        entry.outputBuffer.push(`[process exited with code ${child.exitCode}]`);
        logStream.write(`[process exited with code ${child.exitCode}]\n`);
        logStream.end();
      });

      // Initialize injector if agent provides one.
      if (config.agent?.createInjector) {
        try {
          const injector = config.agent.createInjector(child);
          if (injector) {
            await injector.initialize();
            entry.injector = injector;
          }
        } catch (err) {
          console.warn(`[runtime-file] Injector init failed for ${handleId}:`,
            err instanceof Error ? err.message : String(err));
        }
      }

      // Companion tmux session for terminal viewing (ALL agents).
      await createCompanionTmux(handleId, config.workspacePath, logPath);

      return {
        id: handleId,
        runtimeName: "file",
        data: {
          pid: child.pid,
          createdAt: entry.createdAt,
          epoch,
          logPath,
          agentName,
          inboxPath: files.inbox,
          agentEventsPath: files.agentEvents,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      const entry = sessions.get(handle.id);
      if (!entry) return;

      // Kill subprocess.
      const child = entry.process;
      if (child && child.exitCode === null && child.signalCode === null) {
        const pid = child.pid;
        if (pid) {
          try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        } else {
          child.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              if (pid) {
                try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
              } else { child.kill("SIGKILL"); }
            }
            resolve();
          }, 5000);
          child.once("exit", () => { clearTimeout(timeout); resolve(); });
        });
      }

      // Close injector.
      if (entry.injector) {
        try { await entry.injector.close(); } catch { /* best-effort */ }
      }

      // Destroy companion tmux session (terminal viewing only).
      if (entry.companionTmuxName) {
        await destroyCompanionTmux(entry.companionTmuxName);
      }

      entry.logStream?.end();
      removeCommsFiles(entry.files);
      sessions.delete(handle.id);
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      const entry = sessions.get(handle.id);
      if (!entry) {
        throw new Error(`No session found for ${handle.id}`);
      }

      // Always write to inbox first (durable record).
      try {
        appendInboxMessage(
          entry.files.inbox, entry.sessionId, entry.epoch,
          "instruction" as InboxMessageType, message, generateDedupKey(),
        );
      } catch (err) {
        throw new Error(
          `Failed to write message to inbox for session ${entry.sessionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // Agent-specific injection. ZERO tmux send-keys in any path.
      if (entry.injector) {
        // Use agent-provided injector (Claude Code NDJSON, Codex JSON-RPC, etc.)
        try {
          await entry.injector.send(message);
        } catch (err) {
          const child = entry.process;
          const alive = !child || (child.exitCode === null && child.signalCode === null);
          if (!alive) {
            throw new Error(
              `Agent process for session ${entry.sessionId} has exited. ` +
              `Message persisted in inbox but not delivered.`,
            );
          }
          // Injector failed but process alive — inbox is the fallback.
        }
      } else if (entry.agentName === "claude-code") {
        // Built-in fallback: Claude Code stdin NDJSON (when no injector provided).
        const child = entry.process;
        if (!child) return;
        const stdin = child.stdin;
        if (!stdin || !stdin.writable) return;

        const ndjson = formatNdjsonUserMessage(
          `You have a new message in your inbox at ${entry.files.inbox}. ` +
          `Read the file and process the latest messages.`,
          entry.claudeSessionId,
        );

        try {
          await new Promise<void>((resolve, reject) => {
            let done = false;
            const finish = (err?: Error | null) => {
              if (done) return;
              done = true;
              stdin.removeListener("error", onError);
              if (err) reject(err); else resolve();
            };
            const onError = (err: Error) => finish(err);
            stdin.once("error", onError);
            stdin.write(ndjson + "\n", (err) => finish(err ?? null));
          });
        } catch {
          const alive = child.exitCode === null && child.signalCode === null;
          if (!alive) {
            throw new Error(
              `Agent process for session ${entry.sessionId} has exited ` +
              `(code ${child.exitCode}). Message persisted in inbox but not delivered.`,
            );
          }
        }
      } else if (entry.process?.stdin?.writable) {
        // Inbox-only agents: best-effort stdin nudge.
        try {
          entry.process.stdin.write(message + "\n", () => {});
        } catch {
          // Best-effort — inbox has the durable copy.
        }
      }
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      const entry = sessions.get(handle.id);
      if (!entry) return "";

      // Always from in-memory stdout buffer (non-destructive, no cursor consumption).
      const buffer = entry.outputBuffer;
      const start = Math.max(0, buffer.length - lines);
      return buffer.slice(start).join("\n");
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      const entry = sessions.get(handle.id);
      if (!entry) return false;
      if (!entry.process) return false;
      return entry.process.exitCode === null && entry.process.signalCode === null;
    },

    async getMetrics(handle: RuntimeHandle): Promise<RuntimeMetrics> {
      const entry = sessions.get(handle.id);
      return { uptimeMs: entry ? Date.now() - entry.createdAt : 0 };
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      const entry = sessions.get(handle.id);
      if (!entry) {
        return { type: "process", target: "", command: `# session ${handle.id} not found` };
      }

      // Companion tmux session for terminal viewing.
      if (entry.companionTmuxName) {
        return {
          type: "tmux" as AttachInfo["type"],
          target: entry.companionTmuxName,
          command: `tmux attach -t ${entry.companionTmuxName}`,
        };
      }

      return { type: "process", target: "", command: `# no terminal for ${handle.id}` };
    },

    watchEvents(
      handle: RuntimeHandle,
      callback: (events: unknown[]) => void,
    ): () => void {
      const entry = sessions.get(handle.id);
      if (!entry) {
        // Session unknown — return a no-op unsubscribe.
        return () => {};
      }

      const { dir, agentEvents } = entry.files;

      let watcher: ReturnType<typeof watchDirectory> | null = null;

      try {
        watcher = watchDirectory(dir, (filename) => {
          // fs.watch fires for any file in the directory. Only act on the
          // agent-events file; ignore spurious events for other files (inbox,
          // system-events, cursor files, heartbeat).
          if (filename !== null && filename !== AGENT_EVENTS_FILE) return;

          let messages: unknown[] = [];
          try {
            const result = readNewMessages(agentEvents);
            messages = result.messages;
          } catch (err) {
            // readNewMessages failed (e.g. file removed mid-watch). Log and
            // skip — the polling loop will pick this up on its next cycle.
            console.warn(
              `[runtime-file] watchEvents: failed to read agent-events for ${handle.id}:`,
              err instanceof Error ? err.message : String(err),
            );
            return;
          }

          // Spurious fs.watch event with no new content — ignore silently.
          if (messages.length === 0) return;

          try {
            callback(messages);
          } catch (err) {
            // Callback errors must not crash the watcher.
            console.warn(
              `[runtime-file] watchEvents: callback threw for ${handle.id}:`,
              err instanceof Error ? err.message : String(err),
            );
          }
        });
      } catch (err) {
        // fs.watch can fail (NFS, Docker overlayfs, unsupported kernel). Log
        // and degrade gracefully — polling remains the source of truth.
        console.warn(
          `[runtime-file] watchEvents: failed to watch directory "${dir}" for ${handle.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        return () => {};
      }

      return () => {
        try {
          watcher?.close();
        } catch {
          // best effort
        }
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin exports
// ---------------------------------------------------------------------------

export default {
  manifest,
  create,
} satisfies PluginModule<Runtime>;

export {
  resolveCommsFiles, createCommsFiles, appendInboxMessage, appendMessage,
  readNewMessages, readAllMessages, readEpoch, writeEpoch,
  generateDedupKey, touchFile, getHeartbeatTime, watchDirectory,
  resetCursors,
} from "./file-transport.js";

export type { SessionCommsFiles, FileWatcher } from "./file-transport.js";

export * from "./message-types.js";
export {
  getHookSettings, INBOX_READER_SCRIPT, STOP_INBOX_CHECK_SCRIPT, PROMPT_INBOX_CHECK_SCRIPT, FILE_TRACKER_SCRIPT,
} from "./hooks.js";

export { AO_EMIT_SCRIPT, installAoEmit } from "./ao-emit.js";

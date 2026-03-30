import {
  createAgentPlugin,
  findLatestSessionFileMeta,
  parseJsonlFileTail,
  extractSummary,
  extractCost,
  resetPsCache as _resetPsCache,
  type AgentPluginConfig,
} from "@composio/ao-plugin-agent-base";
import { execFileSync } from "node:child_process";
import { readFile, stat, open } from "node:fs/promises";
import { DEFAULT_READY_THRESHOLD_MS, type Agent, type ActivityDetection, type AgentSessionInfo, type PluginModule, type ProjectConfig, type Session } from "@composio/ao-core";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "gemini",
  slot: "agent" as const,
  description: "Agent plugin: Gemini CLI",
  version: "0.1.0",
};

// =============================================================================
// Project Path Encoder
// =============================================================================

/**
 * Convert a workspace path to Gemini's project directory hash.
 * Gemini CLI uses SHA-256 of the workspace path to name its project directory
 * (`~/.gemini/tmp/<hash>/chats/`), unlike Claude Code which uses path-mangling.
 *
 * Exported for testing.
 */
export function toGeminiProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return createHash("sha256").update(normalized).digest("hex");
}

// =============================================================================
// Plugin Config
// =============================================================================

const geminiConfig: AgentPluginConfig = {
  name: "gemini",
  description: "Agent plugin: Gemini CLI",
  processName: "gemini",
  command: "gemini",
  configDir: ".gemini",
  // Gemini CLI uses --yolo (equivalent of --dangerously-skip-permissions)
  permissionlessFlag: "--yolo",
  // Gemini CLI does not support a system prompt CLI flag; prompts are delivered
  // post-launch via sendMessage(), or inline via the GEMINI_SYSTEM_MD env var.
  systemPromptFlag: undefined,
  systemPromptEnvVar: "GEMINI_SYSTEM_MD",
  // Gemini CLI does not expose a direct cost field in JSON session files.
  // Usage fields may still be present and are parsed when available; no
  // built-in price model is configured for monetary estimates.
  // Gemini CLI stores sessions at ~/.gemini/tmp/<sha256(workspacePath)>/chats/
  // (SHA-256 encoding), not the path-mangling scheme used by Claude Code.
  getSessionDir: (workspacePath: string) =>
    join(homedir(), ".gemini", "tmp", toGeminiProjectPath(workspacePath), "chats"),
  // Gemini CLI session files use .json extension, not .jsonl
  sessionFileExtension: ".json",
  // Gemini CLI uses "run_shell_command" for shell execution, not "Bash"
  hookToolMatcher: "run_shell_command",
  // Gemini CLI uses AfterTool hook events, not PostToolUse
  hookEvent: "AfterTool",
};

// =============================================================================
// Gemini native JSON session reader (orch-cb3e)
// =============================================================================


/**
 * Read the last message type from a Gemini session file.
 *
 * Tries native Gemini JSON format first:
 *   { sessionId, messages: [{ type, content, id, timestamp }, ...] }
 * Falls back to JSONL (one JSON object per line) for compatibility.
 *
 * Gemini message types (observed in production):
 *   "user"   → user prompt pending response → active
 *   "gemini" → agent completed its turn     → ready
 *   "error"  → error occurred               → blocked
 *   "info"   → informational progress       → active
 */

/** Max bytes to read from the tail of a Gemini session file for activity detection. */
const ACTIVITY_TAIL_BYTES = 131_072; // 128KB — enough to find the last message type

async function readLastGeminiEntry(
  filePath: string,
  fileMtime: Date,
): Promise<{ lastType: string | null; modifiedAt: Date } | null> {
  try {
    // Read only the tail of the file to avoid loading multi-MB session files.
    const { size = 0 } = await stat(filePath);
    if (size === 0) return null;

    let content: string;
    const offset = Math.max(0, size - ACTIVITY_TAIL_BYTES);
    if (offset === 0) {
      content = await readFile(filePath, "utf-8");
    } else {
      // Large file — read only the tail via a file handle
      const handle = await open(filePath, "r");
      try {
        const length = size - offset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        content = buffer.slice(0, bytesRead).toString("utf-8");
      } finally {
        await handle.close();
      }
    }

    const trimmed = content.trim();
    if (!trimmed) return null;

    // For small files (read in full), try full JSON parse first.
    if (offset === 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (Array.isArray(obj.messages)) {
            if (obj.messages.length === 0) return null;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lastMsg = obj.messages[obj.messages.length - 1] as any;
            const lastType = typeof lastMsg?.type === "string" ? lastMsg.type : null;
            return { lastType, modifiedAt: fileMtime };
          }
        }
      } catch {
        // Not valid JSON — fall through to tail search
      }
    }

    // Tail search: find the last "type": "..." pattern in the content.
    // Works for both truncated native JSON and JSONL formats.
    const typeMatches = [...content.matchAll(/"type"\s*:\s*"([^"]+)"/g)];
    if (typeMatches.length > 0) {
      const lastType = typeMatches[typeMatches.length - 1]![1] ?? null;
      return { lastType, modifiedAt: fileMtime };
    }

    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Gemini-specific overrides
// Gemini CLI does not support session restore via CLI flag (no --resume equivalent).
// getRestoreCommand returns null - sessions must be restored manually or via UI.
// =============================================================================

const geminiOverrides: Partial<Agent> = {
  async getRestoreCommand(_session: Session, _project: ProjectConfig): Promise<string | null> {
    // Gemini CLI does not have a --resume flag; sessions are restored via UI
    return null;
  },

  async getActivityState(
    session: Session,
    readyThresholdMs?: number,
  ): Promise<ActivityDetection | null> {
    const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

    const exitedAt = new Date();
    if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };
    const running = (await this.isProcessRunning?.(session.runtimeHandle)) ?? false;
    if (!running) return { state: "exited", timestamp: exitedAt };

    if (!session.workspacePath) return null;

    const projectDir = geminiConfig.getSessionDir?.(session.workspacePath);
    if (!projectDir) return null;

    const latest = await findLatestSessionFileMeta(projectDir, ".json");
    if (!latest) return null;

    const entry = await readLastGeminiEntry(latest.path, new Date(latest.mtime));
    if (!entry) return null;

    const ageMs = Date.now() - entry.modifiedAt.getTime();
    const timestamp = entry.modifiedAt;

    switch (entry.lastType) {
      // Native Gemini types
      case "gemini": // agent completed its turn — done signal
        return { state: ageMs > threshold ? "idle" : "ready", timestamp };
      // Shared types
      case "error":
        return { state: "blocked", timestamp };
      case "user":
      case "info":
        return { state: ageMs > threshold ? "idle" : "active", timestamp };
      // JSONL fallback: Claude Code-compatible types
      case "assistant":
      case "system":
      case "summary":
      case "result":
        return { state: ageMs > threshold ? "idle" : "ready", timestamp };
      case "tool_use":
      case "progress":
        return { state: ageMs > threshold ? "idle" : "active", timestamp };
      case "permission_request":
        return { state: "waiting_input", timestamp };
      default:
        return { state: ageMs > threshold ? "idle" : "active", timestamp };
    }
  },

  async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
    if (!session.workspacePath) return null;

    const projectDir = geminiConfig.getSessionDir?.(session.workspacePath);
    if (!projectDir) return null;

    const latest = await findLatestSessionFileMeta(projectDir, ".json");
    if (!latest) return null;

    // Try native Gemini JSON first: { sessionId, messages: [{type, content, ...}] }
    // Guard: skip full-file parse for files > 2MB to avoid loading huge sessions.
    // Fall through to JSONL tail-read which only reads the last 128KB.
    const MAX_SESSION_INFO_BYTES = 2 * 1024 * 1024;
    let fileSize = 0;
    try {
      const s = await stat(latest.path);
      fileSize = s.size ?? 0;
    } catch { /* will fail on readFile below */ }

    if (fileSize <= MAX_SESSION_INFO_BYTES) try {
      const content = await readFile(latest.path, "utf-8");
      const trimmed = content.trim();
      if (!trimmed) return null;

      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.messages)) {
          const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;
          const agentSessionId =
            sessionId ?? basename(latest.path, geminiConfig.sessionFileExtension ?? ".json");

          // Use last "gemini" message as summary
          const messages = obj.messages as Array<Record<string, unknown>>;
          const lastGemini = [...messages].reverse().find((m) => m["type"] === "gemini");
          const summary =
            typeof lastGemini?.["content"] === "string" ? lastGemini["content"] : null;

          // Native Gemini summary is always a real agent response, not a user-message fallback.
          // Only set summaryIsFallback when a summary is present; leave undefined when null.
          return {
            summary,
            ...(summary !== null && { summaryIsFallback: false }),
            agentSessionId,
            cost: undefined,
          };
        }
      }
    } catch {
      // Not valid single-object JSON — fall through to JSONL
    }

    // JSONL fallback: one JSON object per line (legacy / compatibility format)
    const agentSessionId = basename(latest.path, geminiConfig.sessionFileExtension ?? ".json");
    const lines = await parseJsonlFileTail(latest.path);
    if (lines.length === 0) return null;

    const summaryResult = extractSummary(lines);
    return {
      summary: summaryResult?.summary ?? null,
      summaryIsFallback: summaryResult?.isFallback,
      agentSessionId,
      cost: extractCost(lines, geminiConfig.defaultCostRate),
    };
  },
};

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createAgentPlugin(geminiConfig, geminiOverrides);
}

/** Reset the ps process cache. Exported for testing only. */
export const resetPsCache = _resetPsCache;

export function detect(): boolean {
  try {
    execFileSync("gemini", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;

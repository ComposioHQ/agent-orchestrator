import {
  shellEscape,
  DEFAULT_READY_THRESHOLD_MS,
  type Agent,
  type AgentSessionInfo,
  type AgentLaunchConfig,
  type ActivityDetection,
  type ActivityState,
  type CostEstimate,
  type PluginModule,
  type ProjectConfig,
  type RuntimeHandle,
  type Session,
  type WorkspaceHooksConfig,
} from "@composio/ao-core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SQLITE_TIMEOUT_MS = 5_000;
const SQLITE_PRIMARY_DB_PATH = join(homedir(), ".opencode", "opencode.db");
const SQLITE_FALLBACK_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");
const OPENCODE_CONFIG_MARKER_PREFIX = "__AO_SYSTEM_PROMPT_FILE__:";

const METADATA_UPDATER_PLUGIN = `import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PR_URL_RE = /https:\/\/github[.]com\/[^\/]+\/[^\/]+\/pull\/\d+/;

function getString(value) {
  return typeof value === "string" ? value : "";
}

function getMetadataPath() {
  const dataDir = getString(process.env.AO_DATA_DIR);
  const sessionId = getString(process.env.AO_SESSION);
  if (!dataDir || !sessionId) return null;
  return join(dataDir, sessionId);
}

async function updateMetadata(key, value) {
  if (!value) return;
  const metadataPath = getMetadataPath();
  if (!metadataPath) return;

  let lines = [];
  try {
    const content = await readFile(metadataPath, "utf-8");
    lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return;
  }

  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(key + "=")) {
      lines[i] = key + "=" + value;
      found = true;
      break;
    }
  }
  if (!found) lines.push(key + "=" + value);

  await writeFile(metadataPath, lines.join("\\n") + "\\n", "utf-8");
}

function extractCommand(args) {
  if (!args || typeof args !== "object") return "";
  const record = args;
  return getString(record.command);
}

function extractOutput(output) {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return "";
  const record = output;
  const stdout = getString(record.stdout);
  const text = getString(record.output);
  if (stdout) return stdout;
  if (text) return text;
  return "";
}

function extractBranch(command) {
  const checkoutMatch = command.match(/^git\s+checkout\s+-b\s+([^\s]+)/);
  if (checkoutMatch) return checkoutMatch[1] || "";
  const switchMatch = command.match(/^git\s+switch\s+-c\s+([^\s]+)/);
  if (switchMatch) return switchMatch[1] || "";
  return "";
}

export const hooks = {
  "tool.execute.after": async ({ tool, args, output }) => {
    const toolName = typeof tool === "string" ? tool : getString(tool && tool.name);
    if (toolName && !/bash/i.test(toolName)) {
      return;
    }

    const command = extractCommand(args);
    if (!command) return;

    const commandOutput = extractOutput(output);

    if (/^gh\s+pr\s+create\b/.test(command)) {
      const prUrl = commandOutput.match(PR_URL_RE)?.[0] || "";
      if (prUrl) {
        await updateMetadata("pr", prUrl);
        await updateMetadata("status", "pr_open");
      }
      return;
    }

    if (/^gh\s+pr\s+merge\b/.test(command)) {
      await updateMetadata("status", "merged");
      return;
    }

    const branch = extractBranch(command);
    if (branch) {
      await updateMetadata("branch", branch);
    }
  },
};
`;

export const manifest = {
  name: "opencode",
  slot: "agent" as const,
  description: "Agent plugin: OpenCode",
  version: "0.1.0",
};

interface SqliteSessionRow {
  id?: unknown;
  title?: unknown;
  time_updated?: unknown;
}

interface SqliteMessageRow {
  data?: unknown;
  time_updated?: unknown;
}

interface ParsedMessage {
  role: "assistant" | "user" | "tool" | "permission_request" | "error" | "unknown";
  timestamp: Date | null;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"') {
      const prev = content[i - 1] ?? "";
      if (prev !== "\\") {
        inString = !inString;
      }
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(content: string): string {
  return content.replace(/,\s*([}\]])/g, "$1");
}

function parseJsoncObject(content: string): Record<string, unknown> {
  try {
    const stripped = stripTrailingCommas(stripJsonComments(content));
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function toDate(value: unknown): Date | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const ms = value > 1_000_000_000_000 ? value : value * 1_000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return toDate(numeric);
    }
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function findSqliteDbPath(): Promise<string | null> {
  if (existsSync(SQLITE_PRIMARY_DB_PATH)) return SQLITE_PRIMARY_DB_PATH;
  if (existsSync(SQLITE_FALLBACK_DB_PATH)) return SQLITE_FALLBACK_DB_PATH;
  return null;
}

async function querySqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], {
    timeout: SQLITE_TIMEOUT_MS,
  });
  const raw = stdout.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed as T[];
}

async function getLatestSessionRow(workspacePath: string): Promise<SqliteSessionRow | null> {
  const dbPath = await findSqliteDbPath();
  if (!dbPath) return null;

  const escaped = escapeSqlLiteral(workspacePath);
  const sql = `SELECT id, title, time_updated FROM session WHERE directory = '${escaped}' ORDER BY time_updated DESC LIMIT 1;`;

  const rows = await querySqliteJson<SqliteSessionRow>(dbPath, sql);
  return rows[0] ?? null;
}

async function getLatestMessageRow(workspacePath: string): Promise<SqliteMessageRow | null> {
  const dbPath = await findSqliteDbPath();
  if (!dbPath) return null;

  const escaped = escapeSqlLiteral(workspacePath);
  const sql = `SELECT data, time_updated FROM message WHERE session_id = (SELECT id FROM session WHERE directory = '${escaped}' ORDER BY time_updated DESC LIMIT 1) ORDER BY time_updated DESC LIMIT 1;`;

  const rows = await querySqliteJson<SqliteMessageRow>(dbPath, sql);
  return rows[0] ?? null;
}

async function getSessionMessages(sessionId: string): Promise<SqliteMessageRow[]> {
  const dbPath = await findSqliteDbPath();
  if (!dbPath) return [];

  const escaped = escapeSqlLiteral(sessionId);
  const sql = `SELECT data, time_updated FROM message WHERE session_id = '${escaped}' ORDER BY time_updated DESC LIMIT 500;`;

  return querySqliteJson<SqliteMessageRow>(dbPath, sql);
}

function parseMessageData(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return toRecord(parsed);
    } catch {
      return null;
    }
  }
  return toRecord(raw);
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return toRecord(record[key]);
}

function getNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readNumberFromCandidates(
  root: Record<string, unknown>,
  candidates: Array<[Record<string, unknown>, string]>,
): number | null {
  for (const [record, key] of candidates) {
    const v = getNumber(record, key);
    if (v !== null) return v;
  }
  const info = getNestedRecord(root, "info");
  if (info) {
    for (const [_, key] of candidates) {
      const v = getNumber(info, key);
      if (v !== null) return v;
    }
  }
  return null;
}

function parseMessageRole(data: Record<string, unknown>): ParsedMessage["role"] {
  const roleCandidates = [
    toStringValue(data.role),
    toStringValue(data.type),
    toStringValue(data.kind),
    toStringValue(data.event),
    toStringValue(getNestedRecord(data, "message")?.role),
    toStringValue(getNestedRecord(data, "message")?.type),
    toStringValue(getNestedRecord(data, "info")?.role),
    toStringValue(getNestedRecord(data, "info")?.type),
  ].filter((v): v is string => v !== null);

  const merged = roleCandidates.join(" ").toLowerCase();

  if (merged.includes("permission") || merged.includes("allow") || merged.includes("deny")) {
    return "permission_request";
  }
  if (merged.includes("error") || merged.includes("failed") || merged.includes("blocked")) {
    return "error";
  }
  if (merged.includes("assistant")) return "assistant";
  if (merged.includes("tool") || merged.includes("command")) return "tool";
  if (merged.includes("user")) return "user";
  return "unknown";
}

function parseLatestMessage(row: SqliteMessageRow | null): ParsedMessage | null {
  if (!row) return null;
  const data = parseMessageData(row.data);
  if (!data) return null;

  return {
    role: parseMessageRole(data),
    timestamp: toDate(row.time_updated),
  };
}

function classifyActivityFromMessage(
  message: ParsedMessage,
  thresholdMs: number,
): ActivityDetection {
  const timestamp = message.timestamp ?? new Date();
  const ageMs = Date.now() - timestamp.getTime();
  if (ageMs > thresholdMs) {
    return { state: "idle", timestamp };
  }

  switch (message.role) {
    case "assistant":
      return { state: "ready", timestamp };
    case "user":
    case "tool":
      return { state: "active", timestamp };
    case "permission_request":
      return { state: "waiting_input", timestamp };
    case "error":
      return { state: "blocked", timestamp };
    default:
      return { state: "active", timestamp };
  }
}

function aggregateCost(messages: SqliteMessageRow[]): CostEstimate | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;

  for (const msg of messages) {
    const data = parseMessageData(msg.data);
    if (!data) continue;

    const usage =
      getNestedRecord(data, "usage") ??
      getNestedRecord(getNestedRecord(data, "info") ?? {}, "usage") ??
      getNestedRecord(getNestedRecord(data, "message") ?? {}, "usage");

    const directCost = readNumberFromCandidates(data, [
      [data, "costUSD"],
      [data, "costUsd"],
      [data, "totalCostUsd"],
    ]);
    const fallbackCost = readNumberFromCandidates(data, [[data, "estimatedCostUsd"]]);
    if (directCost !== null) {
      estimatedCostUsd += directCost;
    } else if (fallbackCost !== null) {
      estimatedCostUsd += fallbackCost;
    }

    if (usage) {
      inputTokens +=
        (getNumber(usage, "input_tokens") ?? 0) +
        (getNumber(usage, "cache_read_input_tokens") ?? 0) +
        (getNumber(usage, "cache_creation_input_tokens") ?? 0) +
        (getNumber(usage, "prompt_tokens") ?? 0);
      outputTokens +=
        (getNumber(usage, "output_tokens") ?? 0) + (getNumber(usage, "completion_tokens") ?? 0);
      continue;
    }

    inputTokens +=
      readNumberFromCandidates(data, [
        [data, "inputTokens"],
        [data, "input_tokens"],
        [data, "promptTokens"],
        [data, "prompt_tokens"],
      ]) ?? 0;
    outputTokens +=
      readNumberFromCandidates(data, [
        [data, "outputTokens"],
        [data, "output_tokens"],
        [data, "completionTokens"],
        [data, "completion_tokens"],
      ]) ?? 0;
  }

  if (inputTokens === 0 && outputTokens === 0 && estimatedCostUsd === 0) {
    return undefined;
  }

  return { inputTokens, outputTokens, estimatedCostUsd };
}

function buildConfigContentFromPrompt(prompt: string): string {
  return JSON.stringify({ instructions: [prompt] });
}

function createFileBasedConfigContentExpression(systemPromptFile: string): string {
  const escapedPath = shellEscape(systemPromptFile);
  return `"$(cat ${escapedPath} | node -e 'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",(c)=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({instructions:[d]})));')"`;
}

function buildPromptEnvPrefix(config: AgentLaunchConfig): string | null {
  if (config.systemPromptFile) {
    return `OPENCODE_CONFIG_CONTENT=${createFileBasedConfigContentExpression(config.systemPromptFile)}`;
  }
  return null;
}

function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trimEnd().split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  if (/^[\$❯>]$/.test(lastLine)) {
    return "idle";
  }

  const tail = lines.slice(-8).join("\n").toLowerCase();
  if (
    /\b(allow|deny|permission|approve|reject|grant access|confirm)\b/.test(tail) ||
    /\(y\)es[\s/|]*(?:or\s*)?\(n\)o/.test(tail)
  ) {
    return "waiting_input";
  }

  return "active";
}

async function setupOpenCodeHooksInWorkspace(workspacePath: string): Promise<void> {
  const opencodeDir = join(workspacePath, ".opencode");
  const pluginDir = join(opencodeDir, "plugins");
  const pluginPath = join(pluginDir, "ao-metadata-updater.mjs");
  const configPath = join(workspacePath, "opencode.jsonc");

  await mkdir(pluginDir, { recursive: true });
  await writeFile(pluginPath, METADATA_UPDATER_PLUGIN, "utf-8");

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const existing = await readFile(configPath, "utf-8");
      config = parseJsoncObject(existing);
    } catch {
      config = {};
    }
  }

  const pluginEntry = "file://.opencode/plugins/ao-metadata-updater.mjs";
  const plugins = config.plugin;

  if (Array.isArray(plugins)) {
    const values = plugins.filter((item): item is string => typeof item === "string");
    if (!values.includes(pluginEntry)) {
      values.push(pluginEntry);
    }
    config.plugin = values;
  } else if (typeof plugins === "string") {
    if (plugins === pluginEntry) {
      config.plugin = [pluginEntry];
    } else {
      config.plugin = [plugins, pluginEntry];
    }
  } else {
    config.plugin = [pluginEntry];
  }

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

function createOpenCodeAgent(): Agent {
  return {
    name: "opencode",
    processName: "opencode",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = ["opencode", "run"];

      if (config.prompt) {
        parts.push(shellEscape(config.prompt));
      }

      parts.push("--format", "json");
      parts.push("--title", shellEscape(config.sessionId));

      const projectAgent = config.projectConfig.agentConfig?.agent;
      if (typeof projectAgent === "string" && projectAgent.trim().length > 0) {
        parts.push("--agent", shellEscape(projectAgent));
      }

      if (config.projectConfig.path) {
        parts.push("--dir", shellEscape(config.projectConfig.path));
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      const command = parts.join(" ");
      const promptPrefix = buildPromptEnvPrefix(config);
      if (promptPrefix) {
        return `${promptPrefix} ${command}`;
      }
      return command;
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {
        AO_SESSION_ID: config.sessionId,
      };

      if (config.issueId) {
        env.AO_ISSUE_ID = config.issueId;
      }

      if (config.permissions === "skip") {
        env.AO_OPENCODE_PERMISSIONS = "skip";
      }

      if (config.systemPromptFile) {
        env.OPENCODE_CONFIG_CONTENT = `${OPENCODE_CONFIG_MARKER_PREFIX}${config.systemPromptFile}`;
      } else if (config.systemPrompt) {
        env.OPENCODE_CONFIG_CONTENT = buildConfigContentFromPrompt(config.systemPrompt);
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;

      const exitedAt = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp: exitedAt };

      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      try {
        const latestRow = await getLatestMessageRow(session.workspacePath);
        if (!latestRow) return null;

        const parsedMessage = parseLatestMessage(latestRow);
        if (!parsedMessage) return null;

        return classifyActivityFromMessage(parsedMessage, threshold);
      } catch {
        return null;
      }
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      try {
        if (handle.runtimeName === "tmux" && handle.id) {
          const { stdout: ttyOut } = await execFileAsync(
            "tmux",
            ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
            { timeout: 30_000 },
          );
          const ttys = ttyOut
            .trim()
            .split("\n")
            .map((t) => t.trim())
            .filter(Boolean);
          if (ttys.length === 0) return false;

          const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
            timeout: 30_000,
          });
          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)opencode(?:\s|$)/;
          for (const line of psOut.split("\n")) {
            const cols = line.trimStart().split(/\s+/);
            if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
            const args = cols.slice(2).join(" ");
            if (processRe.test(args)) {
              return true;
            }
          }
          return false;
        }

        const rawPid = handle.data.pid;
        const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "EPERM") {
              return true;
            }
            return false;
          }
        }

        return false;
      } catch {
        return false;
      }
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.workspacePath) return null;

      try {
        const sessionRow = await getLatestSessionRow(session.workspacePath);
        if (!sessionRow) return null;

        const sessionId = toStringValue(sessionRow.id);
        if (!sessionId) return null;

        const title = toStringValue(sessionRow.title);
        const messages = await getSessionMessages(sessionId);

        return {
          summary: title,
          agentSessionId: sessionId,
          cost: aggregateCost(messages),
        };
      } catch {
        return null;
      }
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      try {
        const latestSession = await getLatestSessionRow(session.workspacePath);
        const sessionId = latestSession ? toStringValue(latestSession.id) : null;
        if (!sessionId) return null;

        const parts: string[] = [
          "opencode",
          "run",
          "--session",
          shellEscape(sessionId),
          "--continue",
          "--format",
          "json",
        ];

        if (project.agentConfig?.model && typeof project.agentConfig.model === "string") {
          parts.push("--model", shellEscape(project.agentConfig.model));
        }

        return parts.join(" ");
      } catch {
        return null;
      }
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupOpenCodeHooksInWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      if (!session.workspacePath) return;
      await setupOpenCodeHooksInWorkspace(session.workspacePath);
    },
  };
}

export function create(): Agent {
  return createOpenCodeAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;

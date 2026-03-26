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
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, createReadStream } from "node:fs";
import { access, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// =============================================================================
// Permission Mode Normalization
// =============================================================================

function normalizePermissionMode(
  mode: string | undefined,
): "permissionless" | "default" | "auto-edit" | "suggest" | undefined {
  if (!mode) return undefined;
  if (mode === "skip") return "permissionless";
  if (
    mode === "permissionless" ||
    mode === "default" ||
    mode === "auto-edit" ||
    mode === "suggest"
  ) {
    return mode;
  }
  return undefined;
}

// =============================================================================
// Shared AO Wrapper Setup
// =============================================================================

const DEFAULT_PATH = "/usr/bin:/bin";
const PREFERRED_GH_BIN_DIR = "/usr/local/bin";
const PREFERRED_GH_PATH = `${PREFERRED_GH_BIN_DIR}/gh`;
const AO_WRAPPER_VERSION = "0.1.1";

function getAoBinDir(): string {
  return join(homedir(), ".ao", "bin");
}

function buildAgentPath(basePath: string | undefined): string {
  const inherited = (basePath ?? DEFAULT_PATH).split(":").filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();

  const add = (entry: string): void => {
    if (!entry || seen.has(entry)) return;
    ordered.push(entry);
    seen.add(entry);
  };

  add(getAoBinDir());
  add(PREFERRED_GH_BIN_DIR);
  for (const entry of inherited) add(entry);

  return ordered.join(":");
}

/* eslint-disable no-useless-escape -- \$ escapes are intentional for shell wrapper literals */
const AO_METADATA_HELPER = `#!/usr/bin/env bash
# ao-metadata-helper — shared by gh/git wrappers
# Provides: update_ao_metadata <key> <value>

update_ao_metadata() {
  local key="\$1" value="\$2"
  local ao_dir="\${AO_DATA_DIR:-}"
  local ao_session="\${AO_SESSION:-}"

  [[ -z "\$ao_dir" || -z "\$ao_session" ]] && return 0

  case "\$ao_session" in
    */* | *..*) return 0 ;;
  esac

  case "\$ao_dir" in
    "\$HOME"/.ao/* | "\$HOME"/.agent-orchestrator/* | /tmp/*) ;;
    *) return 0 ;;
  esac

  local metadata_file="\$ao_dir/\$ao_session"

  local real_dir real_ao_dir
  real_ao_dir="\$(cd "\$ao_dir" 2>/dev/null && pwd -P)" || return 0
  real_dir="\$(cd "\$(dirname "\$metadata_file")" 2>/dev/null && pwd -P)" || return 0
  [[ "\$real_dir" == "\$real_ao_dir"* ]] || return 0

  [[ -f "\$metadata_file" ]] || return 0

  local temp_file="\${metadata_file}.tmp.\$\$"
  local clean_value="\$(printf '%s' "\$value" | tr -d '\\n')"
  local escaped_value="\$(printf '%s' "\$clean_value" | sed 's/[&|\\\\]/\\\\&/g')"

  if grep -q "^\${key}=" "\$metadata_file" 2>/dev/null; then
    sed "s|^\${key}=.*|\${key}=\${escaped_value}|" "\$metadata_file" > "\$temp_file"
  else
    cp "\$metadata_file" "\$temp_file"
    printf '%s=%s\\n' "\$key" "\$clean_value" >> "\$temp_file"
  fi

  mv "\$temp_file" "\$metadata_file"
}
`;

const GH_WRAPPER = `#!/usr/bin/env bash
# ao gh wrapper — auto-updates session metadata on PR operations

ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_gh=""

if [[ -n "\${GH_PATH:-}" && -x "\$GH_PATH" ]]; then
  gh_dir="\$(cd "\$(dirname "\$GH_PATH")" 2>/dev/null && pwd)"
  if [[ "\$gh_dir" != "\$ao_bin_dir" ]]; then
    real_gh="\$GH_PATH"
  fi
fi

if [[ -z "\$real_gh" ]]; then
  real_gh="\$(PATH="\$clean_path" command -v gh 2>/dev/null)"
fi

if [[ -z "\$real_gh" ]]; then
  echo "ao-wrapper: gh not found in PATH" >&2
  exit 127
fi

source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

case "\$1/\$2" in
  pr/create|pr/merge)
    tmpout="\$(mktemp)"
    trap 'rm -f "\$tmpout"' EXIT

    "\$real_gh" "\$@" 2>&1 | tee "\$tmpout"
    exit_code=\${PIPESTATUS[0]}

    if [[ \$exit_code -eq 0 ]]; then
      output="\$(cat "\$tmpout")"
      case "\$1/\$2" in
        pr/create)
          pr_url="\$(echo "\$output" | grep -Eo 'https://github\\.com/[^/]+/[^/]+/pull/[0-9]+' | head -1)"
          if [[ -n "\$pr_url" ]]; then
            update_ao_metadata pr "\$pr_url"
            update_ao_metadata status pr_open
          fi
          ;;
        pr/merge)
          update_ao_metadata status merged
          ;;
      esac
    fi

    exit \$exit_code
    ;;
  *)
    exec "\$real_gh" "\$@"
    ;;
esac
`;

const GIT_WRAPPER = `#!/usr/bin/env bash
# ao git wrapper — auto-updates session metadata on branch operations

ao_bin_dir="\$(cd "\$(dirname "\$0")" && pwd)"
clean_path="\$(echo "\$PATH" | tr ':' '\\n' | grep -Fxv "\$ao_bin_dir" | grep . | tr '\\n' ':')"
clean_path="\${clean_path%:}"
real_git="\$(PATH="\$clean_path" command -v git 2>/dev/null)"

if [[ -z "\$real_git" ]]; then
  echo "ao-wrapper: git not found in PATH" >&2
  exit 127
fi

source "\$ao_bin_dir/ao-metadata-helper.sh" 2>/dev/null || true

"\$real_git" "\$@"
exit_code=\$?

if [[ \$exit_code -eq 0 ]]; then
  case "\$1/\$2" in
    checkout/-b)
      update_ao_metadata branch "\$3"
      ;;
    switch/-c)
      update_ao_metadata branch "\$3"
      ;;
  esac
fi

exit \$exit_code
`;

const AO_AGENTS_MD_SECTION = `
## Agent Orchestrator (ao) Session

You are running inside an Agent Orchestrator managed workspace.
Session metadata is updated automatically via shell wrappers.

If automatic updates fail, you can manually update metadata:
\`\`\`bash
~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
# Then call: update_ao_metadata <key> <value>
\`\`\`
`;
/* eslint-enable no-useless-escape */

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.tmp.${suffix}`;
  await writeFile(tmpPath, content, { encoding: "utf-8", mode });
  await rename(tmpPath, filePath);
}

async function setupCursorWorkspace(workspacePath: string): Promise<void> {
  const aoBinDir = getAoBinDir();
  await mkdir(aoBinDir, { recursive: true });

  await atomicWriteFile(join(aoBinDir, "ao-metadata-helper.sh"), AO_METADATA_HELPER, 0o755);

  const markerPath = join(aoBinDir, ".ao-version");
  let needsUpdate = true;
  try {
    const existing = await readFile(markerPath, "utf-8");
    if (existing.trim() === AO_WRAPPER_VERSION) needsUpdate = false;
  } catch {
    // missing marker => rewrite wrappers
  }

  if (needsUpdate) {
    await atomicWriteFile(join(aoBinDir, "gh"), GH_WRAPPER, 0o755);
    await atomicWriteFile(join(aoBinDir, "git"), GIT_WRAPPER, 0o755);
    await atomicWriteFile(markerPath, AO_WRAPPER_VERSION, 0o644);
  }

  const agentsMdPath = join(workspacePath, "AGENTS.md");
  let existingAgents = "";
  try {
    existingAgents = await readFile(agentsMdPath, "utf-8");
  } catch {
    // AGENTS.md absent
  }

  if (!existingAgents.includes("Agent Orchestrator (ao) Session")) {
    const content = existingAgents
      ? existingAgents.trimEnd() + "\n" + AO_AGENTS_MD_SECTION
      : AO_AGENTS_MD_SECTION.trimStart();
    await writeFile(agentsMdPath, content, "utf-8");
  }
}

// =============================================================================
// Cursor Session Discovery and Parsing
// =============================================================================

const SESSION_ARTIFACT_CACHE_TTL_MS = 30_000;
const PS_CACHE_TTL_MS = 5_000;
const DEFAULT_INPUT_TOKEN_CHARS = 4;
const DEFAULT_OUTPUT_TOKEN_CHARS = 4;

interface CursorTranscriptContentPart {
  type?: string;
  text?: string;
}

interface CursorTranscriptLine {
  role?: string;
  message?: {
    content?: CursorTranscriptContentPart[];
  };
}

interface CursorTranscriptData {
  firstUserText: string | null;
  lastRole: string | null;
  assistantChars: number;
}

interface CursorStoreMeta {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
}

interface CursorStoreData {
  title: string | null;
  model: string | null;
  inputChars: number;
}

interface CursorSessionArtifacts {
  chatId: string;
  transcriptFile: string | null;
  storeDbPath: string | null;
}

let sessionArtifactsCache = new Map<string, { value: CursorSessionArtifacts | null; expiry: number }>();
let psCache: { output: string; timestamp: number; promise?: Promise<string> } | null = null;
let detectCache: boolean | null = null;
let resolvedBinaryCache: string | null = null;
let resolvingBinaryCache: Promise<string> | null = null;

function countMeaningfulChars(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\uFFFD") continue;
    if (code === 9 || code === 10 || code === 13) {
      count++;
      continue;
    }
    if (code >= 32 && !(code >= 127 && code <= 159)) {
      count++;
    }
  }
  return count;
}

function truncateSummary(text: string): string {
  return text.length > 120 ? text.substring(0, 120) + "..." : text;
}

function isGenericCursorTitle(title: string | null | undefined): boolean {
  if (!title) return true;
  return /^(new agent|untitled|new chat)$/i.test(title.trim());
}

function extractTranscriptText(parts: CursorTranscriptContentPart[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function encodeCursorProjectPath(workspacePath: string): string {
  return workspacePath.replace(/^[\\/]+/, "").replace(/[/.]/g, "-");
}

function hashCursorWorkspacePath(workspacePath: string): string {
  return createHash("md5").update(workspacePath).digest("hex");
}

function getCursorProjectDir(workspacePath: string): string {
  return join(homedir(), ".cursor", "projects", encodeCursorProjectPath(workspacePath));
}

function getCursorWorkerLogPath(workspacePath: string): string {
  return join(getCursorProjectDir(workspacePath), "worker.log");
}

function getCursorTranscriptRoot(workspacePath: string): string {
  return join(getCursorProjectDir(workspacePath), "agent-transcripts");
}

function getCursorStoreRoot(workspacePath: string): string {
  return join(homedir(), ".cursor", "chats", hashCursorWorkspacePath(workspacePath));
}

async function listCursorTranscriptFiles(
  workspacePath: string,
): Promise<Array<{ chatId: string; path: string; mtimeMs: number }>> {
  const root = getCursorTranscriptRoot(workspacePath);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const results: Array<{ chatId: string; path: string; mtimeMs: number }> = [];
  for (const chatId of entries) {
    const transcriptPath = join(root, chatId, `${chatId}.jsonl`);
    try {
      const s = await stat(transcriptPath);
      results.push({ chatId, path: transcriptPath, mtimeMs: s.mtimeMs });
    } catch {
      // missing transcript file
    }
  }
  return results;
}

async function listCursorStoreDbs(
  workspacePath: string,
): Promise<Array<{ chatId: string; path: string; mtimeMs: number }>> {
  const root = getCursorStoreRoot(workspacePath);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const results: Array<{ chatId: string; path: string; mtimeMs: number }> = [];
  for (const chatId of entries) {
    const storeDbPath = join(root, chatId, "store.db");
    try {
      const s = await stat(storeDbPath);
      results.push({ chatId, path: storeDbPath, mtimeMs: s.mtimeMs });
    } catch {
      // missing store db
    }
  }
  return results;
}

async function findLatestCursorSessionArtifacts(
  workspacePath: string,
): Promise<CursorSessionArtifacts | null> {
  const candidates = new Map<
    string,
    { chatId: string; transcriptFile: string | null; storeDbPath: string | null; latestMtimeMs: number }
  >();

  for (const transcript of await listCursorTranscriptFiles(workspacePath)) {
    const existing = candidates.get(transcript.chatId);
    candidates.set(transcript.chatId, {
      chatId: transcript.chatId,
      transcriptFile: transcript.path,
      storeDbPath: existing?.storeDbPath ?? null,
      latestMtimeMs: Math.max(existing?.latestMtimeMs ?? 0, transcript.mtimeMs),
    });
  }

  for (const store of await listCursorStoreDbs(workspacePath)) {
    const existing = candidates.get(store.chatId);
    candidates.set(store.chatId, {
      chatId: store.chatId,
      transcriptFile: existing?.transcriptFile ?? null,
      storeDbPath: store.path,
      latestMtimeMs: Math.max(existing?.latestMtimeMs ?? 0, store.mtimeMs),
    });
  }

  const latest = [...candidates.values()].sort((a, b) => b.latestMtimeMs - a.latestMtimeMs)[0];
  return latest
    ? {
        chatId: latest.chatId,
        transcriptFile: latest.transcriptFile,
        storeDbPath: latest.storeDbPath,
      }
    : null;
}

async function findLatestCursorSessionArtifactsCached(
  workspacePath: string,
): Promise<CursorSessionArtifacts | null> {
  const cached = sessionArtifactsCache.get(workspacePath);
  if (cached && Date.now() < cached.expiry) {
    return cached.value;
  }

  const value = await findLatestCursorSessionArtifacts(workspacePath);
  sessionArtifactsCache.set(workspacePath, {
    value,
    expiry: Date.now() + SESSION_ARTIFACT_CACHE_TTL_MS,
  });
  return value;
}

async function readTranscriptData(filePath: string): Promise<CursorTranscriptData | null> {
  try {
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });

    let firstUserText: string | null = null;
    let lastRole: string | null = null;
    let assistantChars = 0;

    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line) as CursorTranscriptLine;
        const role = typeof parsed.role === "string" ? parsed.role : null;
        const text = extractTranscriptText(parsed.message?.content);

        if (role === "user" && !firstUserText && text) {
          firstUserText = text;
        }
        if (role === "assistant" && text) {
          assistantChars += text.length;
        }
        if (role) {
          lastRole = role;
        }
      } catch {
        // skip malformed transcript lines
      }
    }

    return { firstUserText, lastRole, assistantChars };
  } catch {
    return null;
  }
}

function parseCursorMeta(metaHex: string): CursorStoreMeta | null {
  try {
    const decoded = Buffer.from(metaHex, "hex").toString("utf-8");
    const parsed = JSON.parse(decoded) as CursorStoreMeta;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function readStoreData(storeDbPath: string): CursorStoreData | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(storeDbPath, { readOnly: true });

    const metaRow = db
      .prepare("SELECT value FROM meta WHERE key = '0' OR key = 0 LIMIT 1")
      .get() as { value?: string } | undefined;
    const meta = typeof metaRow?.value === "string" ? parseCursorMeta(metaRow.value) : null;

    let model = meta?.lastUsedModel ?? null;
    let inputChars = 0;

    const rows = db.prepare("SELECT data FROM blobs").all() as Array<{ data: Uint8Array }>;
    for (const row of rows) {
      const rawText = Buffer.from(row.data).toString("utf-8");
      const text = rawText.trim();
      if (!text) continue;

      if (!model) {
        const modelMatch = text.match(/"modelName":"([^"]+)"/);
        if (modelMatch?.[1]) {
          model = modelMatch[1];
        }
      }

      if (text.includes('"role":"assistant"')) {
        continue;
      }

      inputChars += countMeaningfulChars(text);
    }

    return {
      title: meta?.name ?? null,
      model,
      inputChars,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function estimateCursorCost(
  inputChars: number,
  assistantChars: number,
  model: string | null,
): CostEstimate | undefined {
  const inputTokens = Math.max(0, Math.round(inputChars / DEFAULT_INPUT_TOKEN_CHARS));
  const outputTokens = Math.max(0, Math.round(assistantChars / DEFAULT_OUTPUT_TOKEN_CHARS));

  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  const modelName = model?.toLowerCase() ?? "";
  let inputPerMillion = 2.5;
  let outputPerMillion = 10.0;

  if (modelName.includes("sonnet")) {
    inputPerMillion = 3.0;
    outputPerMillion = 15.0;
  } else if (modelName.includes("opus")) {
    inputPerMillion = 15.0;
    outputPerMillion = 75.0;
  } else if (modelName.includes("haiku")) {
    inputPerMillion = 0.8;
    outputPerMillion = 4.0;
  } else if (modelName.includes("mini")) {
    inputPerMillion = 0.6;
    outputPerMillion = 2.4;
  }

  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd:
      (inputTokens / 1_000_000) * inputPerMillion +
      (outputTokens / 1_000_000) * outputPerMillion,
  };
}

async function readWorkerLogTail(
  workspacePath: string,
  maxBytes = 32_768,
): Promise<{ text: string; modifiedAt: Date } | null> {
  const filePath = getCursorWorkerLogPath(workspacePath);
  try {
    const s = await stat(filePath);
    const offset = Math.max(0, s.size - maxBytes);

    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(s.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      let content = buffer.subarray(0, bytesRead).toString("utf-8");
      if (offset > 0) {
        const firstNewline = content.indexOf("\n");
        if (firstNewline >= 0) {
          content = content.slice(firstNewline + 1);
        }
      }
      return { text: content, modifiedAt: s.mtime };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function getCachedProcessList(): Promise<string> {
  const now = Date.now();
  if (psCache && now - psCache.timestamp < PS_CACHE_TTL_MS) {
    if (psCache.promise) return psCache.promise;
    return psCache.output;
  }

  const promise = execFileAsync("ps", ["-eo", "pid,tty,args"], {
    timeout: 5_000,
  }).then(({ stdout }) => {
    if (psCache?.promise === promise) {
      psCache = { output: stdout, timestamp: Date.now() };
    }
    return stdout;
  });

  psCache = { output: "", timestamp: now, promise };

  try {
    return await promise;
  } catch {
    if (psCache?.promise === promise) {
      psCache = null;
    }
    return "";
  }
}

function classifyWorkerLogTail(
  text: string,
  timestamp: Date,
  readyThresholdMs: number,
): ActivityDetection | null {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const tail = lines.slice(-40).join("\n");
  if (
    /approval required|approve all servers|continue without approval|permission.*required|allow.*deny|approve|reject|\(y\)es.*\(n\)o/i.test(
      tail,
    )
  ) {
    return { state: "waiting_input", timestamp };
  }
  if (/\[error\]|fatal|uncaught|exception|request initialize failed|tool call failed/i.test(tail)) {
    return { state: "blocked", timestamp };
  }

  const ageMs = Date.now() - timestamp.getTime();
  return ageMs <= readyThresholdMs
    ? { state: "active", timestamp }
    : { state: "idle", timestamp };
}

function buildCursorSessionSummary(
  transcript: CursorTranscriptData | null,
  store: CursorStoreData | null,
): { summary: string | null; summaryIsFallback?: boolean } {
  if (store?.title && !isGenericCursorTitle(store.title)) {
    return { summary: store.title, summaryIsFallback: false };
  }

  const firstUserText = transcript?.firstUserText?.trim();
  if (firstUserText) {
    return {
      summary: truncateSummary(firstUserText),
      summaryIsFallback: true,
    };
  }

  if (store?.model) {
    return {
      summary: `Cursor session (${store.model})`,
      summaryIsFallback: true,
    };
  }

  return { summary: null };
}

// =============================================================================
// Cursor CLI Helpers
// =============================================================================

function buildCursorInvocation(binary: string): string[] {
  const binaryName = basename(binary);
  if (binaryName === "cursor") {
    return [shellEscape(binary), "agent"];
  }
  return [shellEscape(binary)];
}

function buildCursorVersionArgs(binary: string): string[] {
  const binaryName = basename(binary);
  if (binaryName === "cursor") {
    return ["agent", "--version"];
  }
  return ["--version"];
}

function buildInitialPrompt(config: AgentLaunchConfig): string | undefined {
  if (config.systemPromptFile) {
    if (config.prompt) {
      return `"$(cat ${shellEscape(config.systemPromptFile)}; printf '\\n\\n'; printf %s ${shellEscape(config.prompt)})"`;
    }
    return `"$(cat ${shellEscape(config.systemPromptFile)})"`;
  }

  if (config.systemPrompt && config.prompt) {
    return shellEscape(`${config.systemPrompt}\n\n${config.prompt}`);
  }

  if (config.systemPrompt) {
    return shellEscape(config.systemPrompt);
  }

  if (config.prompt) {
    return shellEscape(config.prompt);
  }

  return undefined;
}

function getCursorBinaryCandidates(): string[] {
  const home = homedir();
  return [
    "/usr/local/bin/cursor-agent",
    "/opt/homebrew/bin/cursor-agent",
    join(home, ".local", "bin", "cursor-agent"),
    "/usr/local/bin/cursor",
    "/opt/homebrew/bin/cursor",
    join(home, ".local", "bin", "cursor"),
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
  ];
}

export function resolveCursorBinarySync(): string {
  for (const candidate of ["cursor-agent", "cursor"]) {
    try {
      const resolved = execFileSync("which", [candidate], {
        timeout: 10_000,
        encoding: "utf8",
      }).trim();
      if (resolved) return resolved;
    } catch {
      // not in PATH
    }
  }

  for (const candidate of getCursorBinaryCandidates()) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable
    }
  }

  return "cursor-agent";
}

async function resolveCursorBinaryCached(): Promise<string> {
  if (resolvedBinaryCache) return resolvedBinaryCache;
  if (!resolvingBinaryCache) {
    resolvingBinaryCache = (async () => {
      for (const candidate of ["cursor-agent", "cursor"]) {
        try {
          const { stdout } = await execFileAsync("which", [candidate], {
            timeout: 10_000,
          });
          const resolved = stdout.trim();
          if (resolved) return resolved;
        } catch {
          // not in PATH
        }
      }

      for (const candidate of getCursorBinaryCandidates()) {
        try {
          await access(candidate, constants.X_OK);
          return candidate;
        } catch {
          // not executable
        }
      }

      return "cursor-agent";
    })();
  }

  try {
    resolvedBinaryCache = await resolvingBinaryCache;
    return resolvedBinaryCache;
  } finally {
    resolvingBinaryCache = null;
  }
}

function getResolvedBinarySync(): string {
  if (!resolvedBinaryCache) {
    resolvedBinaryCache = resolveCursorBinarySync();
  }
  return resolvedBinaryCache;
}

// =============================================================================
// Plugin Manifest
// =============================================================================

export const manifest = {
  name: "cursor",
  slot: "agent" as const,
  description: "Agent plugin: Cursor Agent CLI",
  version: "0.1.1",
  displayName: "Cursor",
};

// =============================================================================
// Agent Implementation
// =============================================================================

function createCursorAgent(): Agent {
  return {
    name: "cursor",
    processName: "cursor-agent",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const binary = getResolvedBinarySync();
      const parts: string[] = [
        ...buildCursorInvocation(binary),
        "--workspace",
        shellEscape(config.projectConfig.path),
      ];

      const permissionMode = normalizePermissionMode(config.permissions);
      if (permissionMode === "suggest") {
        parts.push("--mode", "plan");
      }
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--force");
      }

      if (config.model) {
        parts.push("--model", shellEscape(config.model));
      }

      // Verified against Cursor Agent 2026.03.25: positional prompts keep the
      // interactive TUI alive after responding, so inline prompt delivery is correct.
      const initialPrompt = buildInitialPrompt(config);
      if (initialPrompt) {
        parts.push(initialPrompt);
      }

      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};

      env["AO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["AO_ISSUE_ID"] = config.issueId;
      }

      env["PATH"] = buildAgentPath(process.env["PATH"]);
      env["GH_PATH"] = PREFERRED_GH_PATH;

      const apiKey = process.env["CURSOR_API_KEY"];
      if (apiKey) {
        env["CURSOR_API_KEY"] = apiKey;
      }

      const authToken = process.env["CURSOR_AUTH_TOKEN"];
      if (authToken) {
        env["CURSOR_AUTH_TOKEN"] = authToken;
      }

      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      if (!terminalOutput.trim()) return "idle";

      const lines = terminalOutput.trim().split("\n");
      const lastLine = lines[lines.length - 1]?.trim() ?? "";

      if (/^[>$#]\s*$/.test(lastLine)) return "idle";

      const tail = lines.slice(-8).join("\n");
      if (/approval required/i.test(tail)) return "waiting_input";
      if (/permission.*required/i.test(tail)) return "waiting_input";
      if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
      if (/allow.*deny/i.test(tail)) return "waiting_input";
      if (/approve|reject/i.test(tail)) return "waiting_input";

      return "active";
    },

    async getActivityState(
      session: Session,
      readyThresholdMs?: number,
    ): Promise<ActivityDetection | null> {
      const threshold = readyThresholdMs ?? DEFAULT_READY_THRESHOLD_MS;
      const exitedAt = new Date();

      if (!session.runtimeHandle) {
        return { state: "exited", timestamp: exitedAt };
      }
      const running = await this.isProcessRunning(session.runtimeHandle);
      if (!running) return { state: "exited", timestamp: exitedAt };

      if (!session.workspacePath) return null;

      const workerLog = await readWorkerLogTail(session.workspacePath);
      const workerClassification = workerLog
        ? classifyWorkerLogTail(workerLog.text, workerLog.modifiedAt, threshold)
        : null;
      if (workerClassification?.state === "waiting_input" || workerClassification?.state === "blocked") {
        return workerClassification;
      }

      const artifacts = await findLatestCursorSessionArtifactsCached(session.workspacePath);
      const transcriptStats = artifacts?.transcriptFile
        ? await readTranscriptData(artifacts.transcriptFile)
        : null;
      const transcriptTimestamp = artifacts?.transcriptFile
        ? await stat(artifacts.transcriptFile)
            .then((s) => s.mtime)
            .catch(() => null)
        : null;

      if (workerLog && transcriptTimestamp && workerLog.modifiedAt.getTime() > transcriptTimestamp.getTime()) {
        const ageMs = Date.now() - workerLog.modifiedAt.getTime();
        if (ageMs <= threshold) {
          return { state: "active", timestamp: workerLog.modifiedAt };
        }
      }

      if (transcriptStats && transcriptTimestamp) {
        const ageMs = Date.now() - transcriptTimestamp.getTime();
        if (transcriptStats.lastRole === "assistant") {
          return {
            state: ageMs <= threshold ? "ready" : "idle",
            timestamp: transcriptTimestamp,
          };
        }
        if (transcriptStats.lastRole === "user") {
          return {
            state: ageMs <= threshold ? "active" : "idle",
            timestamp: transcriptTimestamp,
          };
        }
      }

      if (workerClassification) return workerClassification;
      return null;
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

          const psOut = await getCachedProcessList();
          if (!psOut) return false;

          const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
          const processRe = /(?:^|\/)(?:cursor-agent|cursor)(?:\s|$)/;
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

        const rawPid = handle.data["pid"];
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

      const artifacts = await findLatestCursorSessionArtifactsCached(session.workspacePath);
      if (!artifacts) return null;

      const transcript = artifacts.transcriptFile
        ? await readTranscriptData(artifacts.transcriptFile)
        : null;
      const store = artifacts.storeDbPath ? readStoreData(artifacts.storeDbPath) : null;
      const summary = buildCursorSessionSummary(transcript, store);
      const cost = estimateCursorCost(store?.inputChars ?? 0, transcript?.assistantChars ?? 0, store?.model ?? null);

      return {
        summary: summary.summary,
        summaryIsFallback: summary.summaryIsFallback,
        agentSessionId: artifacts.chatId,
        cost,
      };
    },

    async getRestoreCommand(session: Session, project: ProjectConfig): Promise<string | null> {
      if (!session.workspacePath) return null;

      const artifacts = await findLatestCursorSessionArtifactsCached(session.workspacePath);
      if (!artifacts?.chatId) return null;

      const binary = getResolvedBinarySync();
      const parts: string[] = [
        ...buildCursorInvocation(binary),
        "--workspace",
        shellEscape(session.workspacePath),
        "--resume",
        shellEscape(artifacts.chatId),
      ];

      const permissionMode = normalizePermissionMode(project.agentConfig?.permissions);
      if (permissionMode === "suggest") {
        parts.push("--mode", "plan");
      }
      if (permissionMode === "permissionless" || permissionMode === "auto-edit") {
        parts.push("--force");
      }

      if (project.agentConfig?.model) {
        parts.push("--model", shellEscape(project.agentConfig.model as string));
      }

      return parts.join(" ");
    },

    async setupWorkspaceHooks(workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      await setupCursorWorkspace(workspacePath);
    },

    async postLaunchSetup(session: Session): Promise<void> {
      await resolveCursorBinaryCached();
      if (!session.workspacePath) return;
      await setupCursorWorkspace(session.workspacePath);
    },
  };
}

// =============================================================================
// Plugin Export
// =============================================================================

export function create(): Agent {
  return createCursorAgent();
}

/** Reset module-level caches. Exported for testing only. */
export function resetCursorCaches(): void {
  sessionArtifactsCache = new Map();
  psCache = null;
  detectCache = null;
  resolvedBinaryCache = null;
  resolvingBinaryCache = null;
}

export function detect(): boolean {
  if (detectCache !== null) return detectCache;

  try {
    const binary = getResolvedBinarySync();
    execFileSync(binary, buildCursorVersionArgs(binary), { stdio: "ignore" });
    detectCache = true;
    return true;
  } catch {
    detectCache = false;
    return false;
  }
}

export default { manifest, create, detect } satisfies PluginModule<Agent>;

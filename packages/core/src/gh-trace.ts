import { execFile } from "node:child_process";
import { access, appendFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { SessionId } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve the real gh binary path, bypassing ~/.ao/bin wrapper.
 * AO-owned calls must NOT go through the wrapper (which is for agent sessions).
 *
 * Strips ~/.ao/bin from PATH and resolves gh from the clean PATH.
 * Cached after first resolution.
 */
let resolvedGhPromise: Promise<string> | null = null;
async function getGhBinaryPath(): Promise<string> {
  if (!resolvedGhPromise) {
    resolvedGhPromise = resolveGhBinary();
  }
  return resolvedGhPromise;
}

async function resolveGhBinary(): Promise<string> {
  // Build a clean PATH without ~/.ao/bin and walk each directory looking
  // for an executable `gh`. Uses fs.access instead of spawning a shell —
  // avoids blocking the event loop and shell injection concerns.
  const aoBinDir = join(homedir(), ".ao", "bin");
  const dirs = (process.env["PATH"] ?? "")
    .split(":")
    .filter((entry) => entry && entry !== aoBinDir);

  for (const dir of dirs) {
    const candidate = join(dir, "gh");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable — try next
    }
  }

  // Last resort — bare "gh" (may hit wrapper, but better than failing)
  return "gh";
}

const GH_TRACE_FILE_ENV = "AO_GH_TRACE_FILE";

export interface GhTraceContext {
  component: string;
  operation?: string;
  projectId?: string;
  sessionId?: SessionId;
  cwd?: string;
}

export interface GhTraceResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
  signal?: string;
}

export interface GhTraceEntry {
  timestamp: string;
  component: string;
  operation: string;
  projectId?: string;
  sessionId?: SessionId;
  cwd?: string;
  args: string[];
  endpoint?: string;
  method?: string;
  ok: boolean;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  statusLine?: string;
  httpStatus?: number;
  etag?: string;
  rateLimitLimit?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  rateLimitResource?: string;
  /** Exact GraphQL cost from response body `rateLimit { cost }` (only for GraphQL calls). */
  graphqlCost?: number;
  /** GraphQL remaining from response body (more accurate than header). */
  graphqlRemaining?: number;
  /** GraphQL reset time from response body. */
  graphqlResetAt?: string;
}

interface HeaderMap {
  [key: string]: string | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIntHeader(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractOperation(args: string[]): string {
  if (args.length === 0) return "gh";
  if (args.length === 1) return `gh.${args[0]}`;
  // Walk past leading flags (e.g. --method, -X, -H) to find the first
  // positional arg after args[0]. Without this, "api --method GET ..."
  // gets bucketed as "gh.api.--method" instead of "gh.api.graphql" etc.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg || arg.startsWith("-")) {
      // Skip flags and their values (--method GET, -X POST, -H "...", etc.)
      if (arg === "--method" || arg === "-X" || arg === "-H" || arg === "--header" ||
          arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field" ||
          arg === "--input" || arg === "-t" || arg === "--template") {
        i++; // skip the flag's value too
      }
      continue;
    }
    // For REST URL paths like "repos/acme/repo/pulls/123/comments?...",
    // extract only the first path segment to keep cardinality bounded.
    // "graphql" stays as-is; "repos/..." becomes "repos"; "user" stays "user".
    const firstSegment = arg.split("/")[0].split("?")[0];
    return `gh.${args[0]}.${firstSegment}`;
  }
  return `gh.${args[0]}`;
}

function extractMethod(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--method" || args[i] === "-X") {
      return args[i + 1];
    }
  }
  return args[0] === "api" ? "GET" : undefined;
}

function extractEndpoint(args: string[]): string | undefined {
  if (args[0] !== "api") return undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--method" || arg === "-X" || arg === "-H" || arg === "--header") {
      i++;
      continue;
    }
    if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") {
      i++;
      continue;
    }
    if (arg === "--input") {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

function parseIncludedHttpResponse(stdout: string): {
  statusLine?: string;
  headers: HeaderMap;
} {
  const headers: HeaderMap = {};
  const normalized = stdout.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const statusLine = lines.find((line) => line.startsWith("HTTP/"));
  if (!statusLine) {
    return { headers };
  }

  const startIndex = lines.indexOf(statusLine);
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) break;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    headers[key] = value;
  }

  return { statusLine, headers };
}

function extractExitCode(err: unknown): number | undefined {
  const candidate = err as { code?: number | string; exitCode?: number };
  if (typeof candidate.exitCode === "number") return candidate.exitCode;
  if (typeof candidate.code === "number") return candidate.code;
  return undefined;
}

function extractSignal(err: unknown): string | undefined {
  const candidate = err as { signal?: string | null };
  return typeof candidate.signal === "string" ? candidate.signal : undefined;
}

const ensuredDirs = new Set<string>();

function writeTrace(entry: GhTraceEntry): void {
  const target = process.env[GH_TRACE_FILE_ENV];
  if (!target) return;

  const dir = dirname(target);
  const line = `${JSON.stringify(entry)}\n`;

  // Fire-and-forget async write — best-effort tracing should not block callers.
  // Skip mkdir once the directory has been successfully created.
  if (ensuredDirs.has(dir)) {
    appendFile(target, line, "utf-8").catch(() => {});
  } else {
    mkdir(dir, { recursive: true })
      .then(() => {
        ensuredDirs.add(dir);
        return appendFile(target, line, "utf-8");
      })
      .catch(() => {});
  }
}

function buildTraceEntry(
  args: string[],
  ctx: GhTraceContext,
  result: GhTraceResult,
  durationMs: number,
): GhTraceEntry {
  const { statusLine, headers } = parseIncludedHttpResponse(result.stdout ?? "");
  const httpStatus = statusLine
    ? Number.parseInt(statusLine.replace(/^HTTP\/[0-9.]+\s+/, "").split(" ")[0] ?? "", 10)
    : undefined;

  return {
    timestamp: nowIso(),
    component: ctx.component,
    operation: ctx.operation ?? extractOperation(args),
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    args,
    endpoint: extractEndpoint(args),
    method: extractMethod(args),
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs,
    stdoutBytes: Buffer.byteLength(result.stdout ?? "", "utf-8"),
    stderrBytes: Buffer.byteLength(result.stderr ?? "", "utf-8"),
    statusLine,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : undefined,
    etag: headers["etag"],
    rateLimitLimit: parseIntHeader(headers["x-ratelimit-limit"]),
    rateLimitRemaining: parseIntHeader(headers["x-ratelimit-remaining"]),
    rateLimitReset: parseIntHeader(headers["x-ratelimit-reset"]),
    rateLimitResource: headers["x-ratelimit-resource"],
    ...parseGraphQLRateLimit(result.stdout ?? "", args),
  };
}

/** Extract rateLimit { cost, remaining, resetAt } from GraphQL response body. */
function parseGraphQLRateLimit(
  stdout: string,
  args: string[],
): Pick<GhTraceEntry, "graphqlCost" | "graphqlRemaining" | "graphqlResetAt"> {
  // Only attempt for GraphQL calls
  if (!args.includes("graphql")) return {};
  // Strip HTTP headers if present (-i flag)
  const bodyMatch = stdout.match(/\r?\n\r?\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : stdout;
  try {
    const parsed = JSON.parse(body.trim());
    const rl = parsed?.data?.rateLimit;
    if (!rl) return {};
    return {
      graphqlCost: typeof rl.cost === "number" ? rl.cost : undefined,
      graphqlRemaining: typeof rl.remaining === "number" ? rl.remaining : undefined,
      graphqlResetAt: typeof rl.resetAt === "string" ? rl.resetAt : undefined,
    };
  } catch {
    return {};
  }
}

export async function execGhObserved(
  args: string[],
  ctx: GhTraceContext,
  timeout: number = 30_000,
): Promise<string> {
  const startedAt = Date.now();

  try {
    const ghPath = await getGhBinaryPath();
    const { stdout, stderr } = await execFileAsync(ghPath, args, {
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      // 10 MB — matches the previous per-caller maxBuffer in scm-github.
      // GraphQL batch queries for 25 PRs can produce multi-MB responses.
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    const entry = buildTraceEntry(
      args,
      ctx,
      { ok: true, stdout, stderr },
      Date.now() - startedAt,
    );
    writeTrace(entry);
    return stdout.trim();
  } catch (err) {
    const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
      ? (err as { stdout: string }).stdout
      : "";
    const stderr = typeof (err as { stderr?: unknown }).stderr === "string"
      ? (err as { stderr: string }).stderr
      : "";
    const entry = buildTraceEntry(
      args,
      ctx,
      {
        ok: false,
        stdout,
        stderr,
        exitCode: extractExitCode(err),
        signal: extractSignal(err),
      },
      Date.now() - startedAt,
    );
    writeTrace(entry);
    throw err;
  }
}

export function getGhTraceFilePath(): string | undefined {
  return process.env[GH_TRACE_FILE_ENV];
}

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { SessionId } from "./types.js";

const execFileAsync = promisify(execFile);

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
    return `gh.${args[0]}.${arg}`;
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

function writeTrace(entry: GhTraceEntry): void {
  const target = process.env[GH_TRACE_FILE_ENV];
  if (!target) return;

  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(entry)}\n`, "utf-8");
}

function buildTraceEntry(
  args: string[],
  ctx: GhTraceContext,
  result: GhTraceResult,
  durationMs: number,
): GhTraceEntry {
  const { statusLine, headers } = parseIncludedHttpResponse(result.stdout);
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
    stdoutBytes: Buffer.byteLength(result.stdout, "utf-8"),
    stderrBytes: Buffer.byteLength(result.stderr, "utf-8"),
    statusLine,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : undefined,
    etag: headers["etag"],
    rateLimitLimit: parseIntHeader(headers["x-ratelimit-limit"]),
    rateLimitRemaining: parseIntHeader(headers["x-ratelimit-remaining"]),
    rateLimitReset: parseIntHeader(headers["x-ratelimit-reset"]),
    rateLimitResource: headers["x-ratelimit-resource"],
  };
}

export async function execGhObserved(
  args: string[],
  ctx: GhTraceContext,
  timeout: number = 30_000,
): Promise<string> {
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync("gh", args, {
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
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

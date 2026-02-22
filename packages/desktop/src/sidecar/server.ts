import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { probeShellCapabilities, selectShellProfile } from "../shell-capabilities.js";
import { runShellCommand, type RunningCommand } from "../shell-runner.js";
import type { ShellSelection } from "../types.js";
import type { RunRequest, SidecarJob } from "./types.js";

interface ServerState {
  jobs: Map<string, SidecarJob>;
  running: Map<string, RunningCommand>;
}

interface CreateDesktopSidecarServerOptions {
  host?: string;
  port?: number;
  shellSelection?: ShellSelection;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateRunRequest(payload: unknown): RunRequest {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid JSON payload");
  }

  const maybe = payload as Partial<RunRequest>;
  if (!maybe.command || typeof maybe.command !== "string") {
    throw new Error("Field 'command' is required");
  }

  if (maybe.profile !== undefined && typeof maybe.profile !== "string") {
    throw new Error("Field 'profile' must be a string");
  }

  if (maybe.cwd !== undefined && typeof maybe.cwd !== "string") {
    throw new Error("Field 'cwd' must be a string");
  }

  if (maybe.wslDistribution !== undefined && typeof maybe.wslDistribution !== "string") {
    throw new Error("Field 'wslDistribution' must be a string");
  }

  return {
    command: maybe.command,
    profile: maybe.profile,
    cwd: maybe.cwd,
    wslDistribution: maybe.wslDistribution,
  };
}

function parseJobId(pathname: string): string | null {
  const m = pathname.match(/^\/jobs\/([^/]+)(?:\/kill)?$/);
  return m?.[1] ?? null;
}

export function createDesktopSidecarServer(opts?: CreateDesktopSidecarServerOptions) {
  const host = opts?.host ?? "127.0.0.1";
  const port = opts?.port ?? 17071;
  const state: ServerState = {
    jobs: new Map(),
    running: new Map(),
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/health") {
        return sendJson(res, 200, {
          ok: true,
          runningJobs: state.running.size,
          totalJobs: state.jobs.size,
        });
      }

      if (method === "GET" && pathname === "/shells") {
        const capabilities = await probeShellCapabilities(opts?.shellSelection);
        return sendJson(res, 200, { capabilities });
      }

      if (method === "POST" && pathname === "/run") {
        const payload = validateRunRequest(await readJson(req));
        const selected = payload.profile
          ? { profileId: payload.profile, resolvedPath: payload.profile }
          : await selectShellProfile(opts?.shellSelection);

        const jobId = randomUUID();
        const job: SidecarJob = {
          id: jobId,
          profile: selected.profileId,
          command: payload.command,
          cwd: payload.cwd,
          status: "running",
          startedAt: new Date(),
          stdout: "",
          stderr: "",
        };
        state.jobs.set(jobId, job);

        const running = runShellCommand(
          {
            profile: selected.profileId,
            command: payload.command,
            cwd: payload.cwd,
            wslDistribution: payload.wslDistribution ?? opts?.shellSelection?.wslDistribution,
          },
          {
            onStdout: (chunk) => {
              const current = state.jobs.get(jobId);
              if (current) current.stdout += chunk;
            },
            onStderr: (chunk) => {
              const current = state.jobs.get(jobId);
              if (current) current.stderr += chunk;
            },
            onExit: (code) => {
              const current = state.jobs.get(jobId);
              if (!current) return;
              current.status = current.status === "killed" ? "killed" : "exited";
              current.exitCode = code;
              current.finishedAt = new Date();
              state.running.delete(jobId);
            },
          },
        );

        state.running.set(jobId, running);
        return sendJson(res, 202, { jobId, profile: selected.profileId, status: "running" });
      }

      if (method === "GET" && pathname.startsWith("/jobs/")) {
        const jobId = parseJobId(pathname);
        if (!jobId) return sendJson(res, 404, { error: "Job not found" });
        const job = state.jobs.get(jobId);
        if (!job) return sendJson(res, 404, { error: "Job not found" });
        return sendJson(res, 200, { job });
      }

      if (method === "POST" && pathname.endsWith("/kill")) {
        const jobId = parseJobId(pathname);
        if (!jobId) return sendJson(res, 404, { error: "Job not found" });
        const running = state.running.get(jobId);
        const job = state.jobs.get(jobId);
        if (!running || !job) return sendJson(res, 404, { error: "Job not running" });

        running.terminate();
        job.status = "killed";
        job.finishedAt = new Date();
        state.running.delete(jobId);
        return sendJson(res, 200, { ok: true, jobId });
      }

      return sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      return sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Unexpected server error",
      });
    }
  });

  return {
    host,
    port,
    state,
    server,
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, host, () => resolve());
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) return reject(err);
          resolve();
        });
      }),
  };
}

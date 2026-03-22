import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const dashboardSession = sessionToDashboard(coreSession);

    // Enrich metadata (issue labels, agent summaries, issue titles)
    await enrichSessionsMetadata([coreSession], [dashboardSession], config, registry);

    // Enrich PR — serve cache immediately, refresh in background if stale
    if (coreSession.pr) {
      const project = resolveProject(coreSession, config.projects);
      const scm = getSCM(registry, project);
      if (scm) {
        const cached = await enrichSessionPR(dashboardSession, scm, coreSession.pr, {
          cacheOnly: true,
        });
        if (!cached) {
          // Nothing cached yet — block once to populate, then future calls use cache
          await enrichSessionPR(dashboardSession, scm, coreSession.pr);
        }
      }
    }

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: coreSession.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(dashboardSession, { status: 200 }, correlationId);
  } catch (error) {
    const { id } = await params;
    const { config, sessionManager } = await getServices().catch(() => ({
      config: undefined,
      sessionManager: undefined,
    }));
    const session = sessionManager ? await sessionManager.get(id).catch(() => null) : null;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: session?.projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { sessionManager } = await getServices();

    const session = await sessionManager.get(id);
    if (!session) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, "");
    }

    const body = (await request.json()) as { llmOverride?: "claude-code" | "local-llm" | null };
    if (!("llmOverride" in body)) {
      return jsonWithCorrelation({ error: "llmOverride field required" }, { status: 400 }, "");
    }

    const newAgent = body.llmOverride; // "claude-code" | "local-llm"
    const ALLOWED_AGENTS = ["claude-code", "local-llm"] as const;
    if (!newAgent || !(ALLOWED_AGENTS as readonly string[]).includes(newAgent)) {
      return jsonWithCorrelation({ error: "llmOverride must be claude-code or local-llm" }, { status: 400 }, "");
    }

    // Skip if already using this agent
    const currentAgent = session.metadata["agent"] ?? "claude-code";
    if (currentAgent === newAgent) {
      return jsonWithCorrelation({ ok: true, newSessionId: id }, { status: 200 }, "");
    }

    const worktreePath = session.metadata["worktree"] || session.workspacePath || null;
    const branch = session.metadata["branch"] || session.branch || undefined;
    const issueId = session.issueId ?? undefined;
    const projectId = session.projectId;

    let handoffContent: string | undefined;

    const isActive =
      session.activity !== null &&
      session.activity !== "exited" &&
      session.status !== "done" &&
      session.status !== "merged";

    if (isActive && currentAgent !== "local-llm") {
      // Active Claude (or other interactive) session — request handoff
      const HANDOFF_PROMPT =
        `Please commit all your current work to git now. ` +
        `Then create a file called HANDOFF.md in the workspace root with these sections:\n` +
        `1. **Current task** — what you were asked to do\n` +
        `2. **Progress** — files changed, tests run, commands executed\n` +
        `3. **Current state** — state of key files and context the next agent needs\n` +
        `4. **Remaining work** — what still needs to be done\n` +
        `5. **Blockers / notes** — anything the next agent should be aware of\n` +
        `After writing and committing HANDOFF.md, stop immediately and do not take any further actions.`;

      try {
        await sessionManager.send(id, HANDOFF_PROMPT);
      } catch {
        // best-effort
      }

      // Poll for HANDOFF.md (2s intervals, 60s max)
      if (worktreePath) {
        const handoffPath = join(worktreePath, "HANDOFF.md");
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          if (existsSync(handoffPath)) {
            handoffContent = readFileSync(handoffPath, "utf-8");
            break;
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
    } else if (currentAgent === "local-llm" || !isActive) {
      // local-llm is one-shot (already exited) — read its output file
      // Also handles any other exited session with an existing HANDOFF.md
      if (worktreePath) {
        const localLlmOutput = join(worktreePath, "local-llm-output.md");
        const handoffFile = join(worktreePath, "HANDOFF.md");
        if (existsSync(localLlmOutput)) {
          handoffContent = readFileSync(localLlmOutput, "utf-8");
        } else if (existsSync(handoffFile)) {
          handoffContent = readFileSync(handoffFile, "utf-8");
        }
      }
    }

    // Kill the current session
    try {
      await sessionManager.kill(id);
    } catch {
      // best-effort — may already be dead
    }

    // Ensure old worktree is freed before spawning on same branch
    if (worktreePath) {
      try {
        const execFileAsync = promisify(execFile);
        // Resolve the repo root BEFORE removing the worktree directory, because
        // `git -C <path>` fails once the directory is gone.
        const repoPath = (
          await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"]).catch(
            () => ({ stdout: "" }),
          )
        ).stdout.trim();
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
        // Prune stale entries — run from the worktreePath's parent repo
        if (repoPath) {
          await execFileAsync("git", ["-C", repoPath, "worktree", "prune"]);
        }
      } catch {
        // best-effort — worktree may already be gone
      }
    }

    // Spawn new session with new agent, same branch/issue, handoff as context
    const spawnPrompt = handoffContent
      ? `**Handoff context from previous agent:**\n\n${handoffContent}`
      : undefined;

    const newSession = await sessionManager.spawn({
      projectId,
      issueId,
      branch,
      agent: newAgent,
      prompt: spawnPrompt,
    });

    return jsonWithCorrelation({ ok: true, newSessionId: newSession.id }, { status: 200 }, "");
  } catch (err) {
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
      "",
    );
  }
}

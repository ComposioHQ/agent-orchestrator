import { type NextRequest, NextResponse } from "next/server";
import { generateOrchestratorPrompt, generateSessionPrefix, isRestorable, isTerminalSession } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import { validateIdentifier, validateConfiguredProject } from "@/lib/validation";
import { mapSessionToOrchestrator, mapSessionsToOrchestrators, selectCanonicalProjectOrchestrator } from "@/lib/orchestrator-utils";

function classifySpawnError(projectId: string, error: unknown): {
  status: number;
  payload: Record<string, unknown>;
} {
  const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";

  if (message.includes("already exists and is still registered with git")) {
    return {
      status: 409,
      payload: {
        error: [
          `AO found older orchestrator workspaces for "${projectId}" that are still registered with git.`,
          "Your repository is safe, but those AO-managed workspaces are blocking a new orchestrator.",
          "To fix it: remove the project from AO, add it again, then spawn the orchestrator once more.",
        ].join(" "),
        code: "orchestrator_workspace_conflict",
        recovery: "remove-and-readd-project",
      },
    };
  }

  return {
    status: 500,
    payload: { error: message },
  };
}

/**
 * GET /api/orchestrators?project=<projectId>
 * List existing orchestrator sessions for a project.
 */
export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get("project");

  if (!projectId) {
    return NextResponse.json({ error: "Missing project query parameter" }, { status: 400 });
  }

  const projectErr = validateIdentifier(projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  try {
    const { config, sessionManager } = await getServices();
    const configProjectErr = validateConfiguredProject(config.projects, projectId);
    if (configProjectErr) {
      return NextResponse.json({ error: configProjectErr }, { status: 404 });
    }
    const project = config.projects[projectId];
    const sessionPrefix = project.sessionPrefix ?? projectId;

    const allSessions = await sessionManager.list(projectId);
    const allSessionPrefixes = Object.entries(config.projects).map(
      ([, p]) => p.sessionPrefix ?? generateSessionPrefix(p.name ?? ""),
    );
    const orchestrators = mapSessionsToOrchestrators(allSessions, sessionPrefix, project.name, allSessionPrefixes);

    return NextResponse.json({ orchestrators, projectName: project.name });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list orchestrators" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const configProjectErr = validateConfiguredProject(config.projects, projectId);
    if (configProjectErr) {
      return NextResponse.json({ error: configProjectErr }, { status: 404 });
    }
    const project = config.projects[projectId];
    const sessionPrefix = project.sessionPrefix ?? projectId;
    const allSessions = await sessionManager.list(projectId);
    const allSessionPrefixes = Object.entries(config.projects).map(
      ([, p]) => p.sessionPrefix ?? generateSessionPrefix(p.name ?? ""),
    );
    const canonical = selectCanonicalProjectOrchestrator(
      allSessions,
      sessionPrefix,
      allSessionPrefixes,
    );

    const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
    const session = await sessionManager.ensureOrchestrator({ projectId, systemPrompt });
    const reusedExisting =
      canonical !== null && !isTerminalSession(canonical) && canonical.id === session.id;
    const restoredExisting =
      canonical !== null &&
      isRestorable(canonical) &&
      canonical.id === session.id &&
      session.restoredAt !== undefined;

    return NextResponse.json(
      {
        orchestrator: mapSessionToOrchestrator(session, project.name),
        ...(reusedExisting ? { reusedExisting: true } : {}),
        ...(restoredExisting ? { reusedExisting: true, restoredExisting: true } : {}),
      },
      { status: reusedExisting || restoredExisting ? 200 : 201 },
    );
  } catch (err) {
    const classified = classifySpawnError(body.projectId as string, err);
    return NextResponse.json(classified.payload, { status: classified.status });
  }
}

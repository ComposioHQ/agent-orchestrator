import { type NextRequest, NextResponse } from "next/server";
import { generateOrchestratorPrompt, generateSessionPrefix } from "@aoagents/ao-core";
import { getServices } from "@/lib/services";
import { validateIdentifier, validateConfiguredProject } from "@/lib/validation";
import { mapSessionsToOrchestrators } from "@/lib/orchestrator-utils";

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

    const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
    const session = await sessionManager.spawnOrchestrator({ projectId, systemPrompt });

    return NextResponse.json(
      {
        orchestrator: {
          id: session.id,
          projectId,
          projectName: project.name,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn orchestrator" },
      { status: 500 },
    );
  }
}

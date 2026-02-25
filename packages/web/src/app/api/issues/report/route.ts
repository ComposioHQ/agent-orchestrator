import { type NextRequest, NextResponse } from "next/server";
import { validateString } from "@/lib/validation";
import { getServices } from "@/lib/services";
import type { Tracker, ProjectConfig } from "@composio/ao-core";

/** POST /api/issues/report — Create a GitHub issue from an error and optionally spawn an agent to fix it. */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const titleErr = validateString(body.title, "title", 256);
  if (titleErr) {
    return NextResponse.json({ error: titleErr }, { status: 400 });
  }

  const descErr = validateString(body.description, "description", 10_000);
  if (descErr) {
    return NextResponse.json({ error: descErr }, { status: 400 });
  }

  // projectId identifies which project to file the issue against (required)
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  const autoFix = body.autoFix !== false; // default: true

  try {
    const { config, registry, sessionManager } = await getServices();
    const project: ProjectConfig | undefined = config.projects[projectId];
    if (!project) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 400 });
    }

    if (!project.tracker) {
      return NextResponse.json({ error: "Project has no tracker configured" }, { status: 400 });
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) {
      return NextResponse.json(
        { error: "Tracker plugin not found: " + project.tracker.plugin },
        { status: 400 },
      );
    }
    if (!tracker.createIssue) {
      return NextResponse.json(
        { error: "Tracker does not support issue creation" },
        { status: 400 },
      );
    }

    // Create the issue
    const issue = await tracker.createIssue(
      {
        title: body.title as string,
        description: body.description as string,
        labels: ["bug", "auto-reported"],
      },
      project,
    );

    let sessionId: string | null = null;

    // Auto-spawn an agent to fix it
    if (autoFix) {
      try {
        const session = await sessionManager.spawn({
          projectId,
          issueId: issue.id,
        });
        sessionId = session.id;
      } catch (spawnErr) {
        // Issue was created but agent spawn failed — still return success with warning
        return NextResponse.json(
          {
            issue,
            sessionId: null,
            warning: `Issue created but agent spawn failed: ${spawnErr instanceof Error ? spawnErr.message : "unknown error"}`,
          },
          { status: 201 },
        );
      }
    }

    return NextResponse.json({ issue, sessionId }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to report issue" },
      { status: 500 },
    );
  }
}

import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import type { Tracker } from "@composio/ao-core";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return NextResponse.json({ error: projectErr }, { status: 400 });
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return NextResponse.json({ error: issueErr }, { status: 400 });
    }
  }

  try {
    const { sessionManager, config, registry } = await getServices();
    const session = await sessionManager.spawn({
      projectId: body.projectId as string,
      issueId: (body.issueId as string) ?? undefined,
      skipPipeline: body.skipPipeline === true ? true : undefined,
    });

    // Fire agent-working reaction: move issue to configured tracker state
    const issueId = (body.issueId as string) ?? undefined;
    if (issueId) {
      const reaction = config.reactions["agent-working"];
      if (reaction?.trackerState) {
        const project = config.projects[body.projectId as string];
        const trackerName = project?.tracker?.plugin ?? "linear";
        const tracker = registry.get<Tracker>("tracker", trackerName);
        if (tracker?.updateIssue) {
          tracker
            .updateIssue(issueId, { stateName: reaction.trackerState }, project)
            .catch(() => {}); // silent-fail: don't block spawn response
        }
      }
    }

    return NextResponse.json({ session: sessionToDashboard(session) }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
    );
  }
}

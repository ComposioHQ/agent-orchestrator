import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import type { DispatcherProjectConfig } from "@composio/ao-core";

export const dynamic = "force-dynamic";

/**
 * GET /api/dispatcher/config?project={id} — Get effective dispatcher config for a project.
 * PUT /api/dispatcher/config — Update runtime dispatcher config for a project.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { dispatcher } = await getServices();
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("project");

    if (!projectId) {
      return NextResponse.json(
        { error: "project query parameter is required" },
        { status: 400 },
      );
    }

    try {
      const config = dispatcher.getProjectConfig(projectId);
      return NextResponse.json({ projectId, config });
    } catch {
      return NextResponse.json(
        { error: `Unknown project: ${projectId}` },
        { status: 404 },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const { dispatcher } = await getServices();
    const body = (await request.json()) as {
      projectId: string;
      config: Partial<DispatcherProjectConfig>;
    };

    if (!body.projectId) {
      return NextResponse.json(
        { error: "projectId is required" },
        { status: 400 },
      );
    }

    dispatcher.updateProjectConfig(body.projectId, body.config);
    const updated = dispatcher.getProjectConfig(body.projectId);

    return NextResponse.json({ projectId: body.projectId, config: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update config";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

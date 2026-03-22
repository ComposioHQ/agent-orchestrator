import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * GET /api/dispatcher — Returns the current dispatcher snapshot (status, scoreboard, config).
 * POST /api/dispatcher — Control the dispatcher (action: start | stop | pause | resume | cycle).
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { dispatcher } = await getServices();
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("project") ?? undefined;

    const snapshot = dispatcher.getSnapshot();

    // If a specific project is requested, also include its config
    let projectConfig = undefined;
    if (projectId) {
      try {
        projectConfig = dispatcher.getProjectConfig(projectId);
      } catch {
        // Project not found — skip config
      }
    }

    return NextResponse.json({ ...snapshot, projectConfig });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get dispatcher state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { dispatcher } = await getServices();
    const body = (await request.json()) as { action: string };
    const { action } = body;

    switch (action) {
      case "start":
        dispatcher.start();
        break;
      case "stop":
        dispatcher.stop();
        break;
      case "pause":
        dispatcher.pause();
        break;
      case "resume":
        dispatcher.resume();
        break;
      case "cycle":
        await dispatcher.runCycleNow();
        break;
      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }

    return NextResponse.json(dispatcher.getSnapshot());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatcher action failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

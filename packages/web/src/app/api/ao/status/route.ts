import webPackage from "../../../../../package.json";
import { checkConfiguredAuth } from "@/app/api/ao/_auth";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authError = checkConfiguredAuth(request);
    if (authError) {
      return authError;
    }

    const { sessionManager } = await getServices();
    const sessions = await sessionManager.list();
    const notifierHealth = sessions.some(
      (session) => sessionToDashboard(session).notificationState?.status === "warn",
    )
      ? "warn"
      : "ok";

    return Response.json({
      version: webPackage.version,
      sessionCount: sessions.length,
      notifierHealth,
      uptime: process.uptime(),
    });
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

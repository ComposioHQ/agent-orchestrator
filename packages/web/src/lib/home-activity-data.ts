import { isOrchestratorSession } from "@composio/ao-core";
import { getCachedPortfolioSessions } from "@/lib/portfolio-services";
import { enrichSessionsMetadata, sessionToDashboard } from "@/lib/serialize";
import { getServices } from "@/lib/services";
import type { PortfolioActivityItem } from "@/lib/types";

const METADATA_ENRICH_TIMEOUT_MS = 3_000;

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(resolve, timeoutMs);
    void promise.finally(() => {
      clearTimeout(timeoutId);
      resolve();
    });
  });
}

export async function loadHomeActivityData(): Promise<{
  activityItems: PortfolioActivityItem[];
}> {
  const portfolioSessions = await getCachedPortfolioSessions().catch(() => []);
  const workerSessions = portfolioSessions.filter((item) => !isOrchestratorSession(item.session));
  const dashboardSessions = workerSessions.map((item) => sessionToDashboard(item.session));

  try {
    const { config, registry } = await getServices();
    await settlesWithin(
      enrichSessionsMetadata(
        workerSessions.map((item) => item.session),
        dashboardSessions,
        config,
        registry,
      ),
      METADATA_ENRICH_TIMEOUT_MS,
    );
  } catch {
    // Best-effort enrichment only. The feed still renders base session data.
  }

  const activityItems = workerSessions
    .map((item, index) => ({
      session: dashboardSessions[index],
      projectId: item.project.id,
      projectName: item.project.name,
    }))
    .sort(
      (left, right) =>
        new Date(right.session.lastActivityAt).getTime() -
        new Date(left.session.lastActivityAt).getTime(),
    );

  return { activityItems };
}

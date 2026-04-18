import { redirect } from "next/navigation";
import { getPortfolioServices, getCachedPortfolioSessions } from "@/lib/portfolio-services";

export const dynamic = "force-dynamic";

function matchesSessionPrefix(sessionId: string, prefix: string | undefined): boolean {
  if (!prefix) return false;
  if (sessionId === prefix) return true;
  if (!sessionId.startsWith(prefix)) return false;
  if (prefix.endsWith("-")) return true;
  return sessionId[prefix.length] === "-";
}

export default async function LegacySessionPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const sessions = await getCachedPortfolioSessions().catch(() => []);
  const match = sessions.find((entry) => entry.session.id === params.id);

  if (match) {
    redirect(
      `/projects/${encodeURIComponent(match.project.id)}/sessions/${encodeURIComponent(match.session.id)}`,
    );
  }

  const { portfolio } = getPortfolioServices();
  const projectFromPrefix = [...portfolio]
    .filter((project) => matchesSessionPrefix(params.id, project.sessionPrefix))
    .sort((a, b) => (b.sessionPrefix?.length ?? 0) - (a.sessionPrefix?.length ?? 0))[0];

  if (projectFromPrefix) {
    redirect(
      `/projects/${encodeURIComponent(projectFromPrefix.id)}/sessions/${encodeURIComponent(params.id)}`,
    );
  }

  redirect("/");
}

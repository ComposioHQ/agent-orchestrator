import { redirect } from "next/navigation";
import { getPortfolioServices, getCachedPortfolioSessions } from "@/lib/portfolio-services";

export const dynamic = "force-dynamic";

export default async function LegacySessionPage(props: {
  params: Promise<{ id: string }>;
}) {
  const params = await props.params;
  const { portfolio } = getPortfolioServices();
  const sessions = await getCachedPortfolioSessions().catch(() => []);
  const match = sessions.find((entry) => entry.session.id === params.id);

  if (match) {
    redirect(
      `/projects/${encodeURIComponent(match.project.id)}/sessions/${encodeURIComponent(match.session.id)}`,
    );
  }

  const projectFromPrefix = portfolio.find(
    (project) => project.sessionPrefix && params.id.startsWith(project.sessionPrefix + "-"),
  );

  if (projectFromPrefix) {
    redirect(
      `/projects/${encodeURIComponent(projectFromPrefix.id)}/sessions/${encodeURIComponent(params.id)}`,
    );
  }

  redirect("/");
}

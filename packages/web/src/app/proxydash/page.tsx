import type { Metadata } from "next";
import { ProxyDash } from "@/components/ProxyDash";
import type { DashboardSession } from "@/lib/types";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getProjectName } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return { title: `proxydash | ${projectName}` };
}

export default async function ProxyDashPage() {
  let sessions: DashboardSession[] = [];
  let projectName = "ao";

  try {
    projectName = getProjectName();
    const { sessionManager } = await getServices();
    const allSessions = await sessionManager.list();
    const coreSessions = allSessions.filter((s) => !s.id.endsWith("-orchestrator"));
    sessions = coreSessions.map(sessionToDashboard);
  } catch {
    // Config not found or services unavailable — show empty state
  }

  return <ProxyDash initialSessions={sessions} projectName={projectName} />;
}

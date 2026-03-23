import type { Metadata } from "next";

export const dynamic = "force-dynamic";
import { Dashboard } from "@/components/Dashboard";
import { getAllProjects } from "@/lib/project-name";
import { fetchDashboardData } from "@/lib/dashboard-data";

export async function generateMetadata(): Promise<Metadata> {
  return { title: { absolute: `ao | All Projects` } };
}

export default async function Home() {
  const pageData = await fetchDashboardData("all");
  const projects = getAllProjects();

  return (
    <Dashboard
      initialSessions={pageData.sessions}
      projectName="All Projects"
      projects={projects}
      initialGlobalPause={pageData.globalPause}
      orchestrators={pageData.orchestrators}
    />
  );
}

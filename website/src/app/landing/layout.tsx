import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { absolute: "Agent Orchestrator — Run 30 AI Agents in Parallel" },
  description:
    "The open-source platform for spawning and managing parallel AI coding agents. One dashboard. Zero babysitting.",
};

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="landing-page min-h-screen">{children}</div>;
}

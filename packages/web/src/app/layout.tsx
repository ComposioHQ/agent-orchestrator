import type { Metadata } from "next";
import { loadConfig } from "@composio/ao-core";
import "./globals.css";

/** Load project name from config for use in page titles. */
function getProjectName(): string {
  try {
    const config = loadConfig();
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      return config.projects[firstKey].name ?? firstKey;
    }
  } catch {
    // Config not available — use default
  }
  return "ao";
}

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return {
    title: {
      template: `%s | ${projectName}`,
      default: `${projectName} | Agent Orchestrator`,
    },
    description: "Dashboard for managing parallel AI coding agents",
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}

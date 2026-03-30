import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { homedir } from "node:os";
import { loadConfig } from "@composio/ao-core";
import { DashboardShell } from "@/components/DashboardShell";
import { AgentSettings } from "@/components/settings/AgentSettings";
import { IntegrationSettings } from "@/components/settings/IntegrationSettings";
import { ProjectSettings } from "@/components/settings/ProjectSettings";
import { getPortfolioServices } from "@/lib/portfolio-services";
import type { AttentionLevel, PortfolioProjectSummary } from "@/lib/types";

export const metadata: Metadata = {
  title: { absolute: "ao | Settings" },
};

function emptyAttentionCounts(): Record<AttentionLevel, number> {
  return {
    merge: 0,
    respond: 0,
    review: 0,
    pending: 0,
    working: 0,
    done: 0,
  };
}

function getAgentDefaults() {
  try {
    const config = loadConfig();
    return {
      agent: config.defaults.agent,
      workspace: config.defaults.workspace,
    };
  } catch {
    return {
      agent: "claude-code",
      workspace: "worktree",
    };
  }
}

export default async function SettingsRoute() {
  const { portfolio } = getPortfolioServices();
  const projectSummaries: PortfolioProjectSummary[] = portfolio
    .map((project) => ({
      id: project.id,
      name: project.name,
      repo: project.repo,
      sessionCount: 0,
      activeCount: 0,
      attentionCounts: emptyAttentionCounts(),
      degraded: project.degraded,
      degradedReason: project.degradedReason,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const agentDefaults = getAgentDefaults();

  return (
    <DashboardShell projects={projectSummaries} defaultLocation={homedir()}>
      <main className="min-h-screen bg-[var(--color-bg-base)] px-5 py-8 text-[var(--color-text-primary)] sm:px-6 lg:px-10">
        <div className="mx-auto max-w-[1120px]">
          <header className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-6 shadow-[var(--card-shadow)]">
            <div className="font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
              Settings
            </div>
            <h1 className="mt-3 text-[var(--font-size-xl)] font-bold tracking-[-0.025em] text-[var(--color-text-primary)]">
              Configure your portfolio
            </h1>
            <p className="mt-3 max-w-[62ch] text-[var(--font-size-base)] leading-relaxed text-[var(--color-text-secondary)]">
              Manage project visibility, ordering, default workspace behavior, and the external services Agent Orchestrator depends on.
            </p>
          </header>

          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
            <div className="space-y-6">
              <section id="projects" className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-6 shadow-[var(--card-shadow)]">
                <ProjectSettings
                  projects={portfolio.map((project) => ({
                    id: project.id,
                    name: project.name,
                    repoPath: project.repoPath,
                    configPath: project.configPath,
                    defaultBranch: project.defaultBranch,
                    sessionPrefix: project.sessionPrefix,
                    enabled: project.enabled,
                    pinned: project.pinned,
                    source: project.source,
                  }))}
                />
              </section>
            </div>

            <div className="space-y-6">
              <section id="agents" className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-6 shadow-[var(--card-shadow)]">
                <AgentSettings
                  defaultAgent={agentDefaults.agent}
                  workspaceStrategy={agentDefaults.workspace}
                />
              </section>

              <section id="integrations" className="rounded-[2px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-6 py-6 shadow-[var(--card-shadow)]">
                <IntegrationSettings />
              </section>
            </div>
          </div>
        </div>
      </main>
    </DashboardShell>
  );
}

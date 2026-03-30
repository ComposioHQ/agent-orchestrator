import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityFeedPage } from "@/components/ActivityFeedPage";
import type { PortfolioActivityItem, PortfolioProjectSummary } from "@/lib/types";

vi.mock("next/navigation", () => ({
  usePathname: () => "/activity",
}));

function makeSummary(
  overrides: Partial<PortfolioProjectSummary> & Pick<PortfolioProjectSummary, "id" | "name">,
): PortfolioProjectSummary {
  return {
    sessionCount: 0,
    activeCount: 0,
    attentionCounts: {
      merge: 0,
      respond: 0,
      review: 0,
      pending: 0,
      working: 0,
      done: 0,
    },
    ...overrides,
  };
}

function makeActivityItem(
  overrides: Partial<PortfolioActivityItem> & {
    projectId: string;
    projectName: string;
    sessionId: string;
  },
): PortfolioActivityItem {
  return {
    projectId: overrides.projectId,
    projectName: overrides.projectName,
    session: {
      id: overrides.sessionId,
      projectId: overrides.projectId,
      status: "running",
      activity: "active",
      branch: "feature/demo",
      issueId: null,
      issueUrl: null,
      issueLabel: null,
      issueTitle: null,
      summary: "Improve project",
      summaryIsFallback: false,
      createdAt: "2026-03-27T10:00:00.000Z",
      lastActivityAt: "2026-03-27T10:30:00.000Z",
      pr: null,
      metadata: {},
      ...overrides.session,
    },
  };
}

describe("ActivityFeedPage", () => {
  it("renders grouped activity rows on the activity page", () => {
    render(
      <ActivityFeedPage
        projectSummaries={[
          makeSummary({ id: "agent-orchestrator", name: "agent-orchestrator" }),
          makeSummary({ id: "docs", name: "docs" }),
        ]}
        activityItems={[
          makeActivityItem({
            projectId: "agent-orchestrator",
            projectName: "agent-orchestrator",
            sessionId: "ao-1",
            session: {
              lastActivityAt: new Date().toISOString(),
              summary: "Improve project",
              branch: "shanghai",
            },
          }),
          makeActivityItem({
            projectId: "docs",
            projectName: "docs",
            sessionId: "docs-1",
            session: {
              lastActivityAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
              summary: "Write architecture",
              branch: "perth-v1",
            },
          }),
        ]}
      />,
    );

    expect(screen.getByRole("textbox", { name: /Filter workspaces/i })).toBeInTheDocument();
    expect(screen.getByText("Improve project")).toBeInTheDocument();
    expect(screen.getByText("Write architecture")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("3 days ago")).toBeInTheDocument();
  });

  it("shows the empty activity state without breaking the shell content", () => {
    render(<ActivityFeedPage projectSummaries={[]} activityItems={[]} />);

    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Open, clone, or quick start a workspace from the sidebar/i),
    ).toBeInTheDocument();
  });

  it("filters activity rows client-side", () => {
    render(
      <ActivityFeedPage
        projectSummaries={[makeSummary({ id: "ao", name: "Agent Orchestrator" })]}
        activityItems={[
          makeActivityItem({
            projectId: "ao",
            projectName: "Agent Orchestrator",
            sessionId: "ao-1",
            session: { summary: "Improve project", branch: "shanghai" },
          }),
          makeActivityItem({
            projectId: "ao",
            projectName: "Agent Orchestrator",
            sessionId: "ao-2",
            session: { summary: "Fix CI", branch: "perth-v1" },
          }),
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /Filter workspaces/i }), {
      target: { value: "perth" },
    });

    expect(screen.queryByText("Improve project")).not.toBeInTheDocument();
    expect(screen.getByText("Fix CI")).toBeInTheDocument();
  });

  it("links rows to project-scoped session pages", () => {
    render(
      <ActivityFeedPage
        projectSummaries={[makeSummary({ id: "ao", name: "Agent Orchestrator" })]}
        activityItems={[
          makeActivityItem({
            projectId: "ao",
            projectName: "Agent Orchestrator",
            sessionId: "ao-1",
          }),
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: /Agent Orchestrator/i })).toHaveAttribute(
      "href",
      "/projects/ao/sessions/ao-1",
    );
  });
});

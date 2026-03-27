import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PortfolioPage } from "@/components/PortfolioPage";
import { makeSession } from "@/__tests__/helpers";
import type { PortfolioActionItem, PortfolioProjectSummary } from "@/lib/types";

vi.mock("@/hooks/usePortfolioEvents", () => ({
  usePortfolioEvents: vi.fn(),
}));

import { usePortfolioEvents } from "@/hooks/usePortfolioEvents";

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

function makeActionItem(overrides: Partial<PortfolioActionItem>): PortfolioActionItem {
  return {
    session: makeSession(),
    projectId: "alpha",
    projectName: "Alpha",
    attentionLevel: "working",
    triageRank: 4,
    ...overrides,
  };
}

describe("PortfolioPage", () => {
  beforeEach(() => {
    vi.mocked(usePortfolioEvents).mockImplementation((actionItems, projectSummaries) => ({
      actionItems,
      projectSummaries,
    }));
  });

  it("renders project panels without session rows", () => {
    const actionItems = [
      makeActionItem({
        session: makeSession({ id: "alpha-7", status: "needs_input", activity: "waiting_input" }),
        projectId: "alpha",
        projectName: "Alpha",
        attentionLevel: "respond",
        triageRank: 0,
      }),
    ];
    const projectSummaries = [
      makeSummary({
        id: "alpha",
        name: "Alpha",
        sessionCount: 1,
        activeCount: 1,
        attentionCounts: { merge: 0, respond: 1, review: 0, pending: 0, working: 0, done: 0 },
      }),
      makeSummary({
        id: "docs",
        name: "Docs",
        sessionCount: 0,
        activeCount: 0,
      }),
    ];

    render(<PortfolioPage actionItems={actionItems} projectSummaries={projectSummaries} />);

    expect(screen.getByRole("link", { name: "Open Alpha board" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Docs board" })).toBeInTheDocument();
    expect(screen.queryByText("alpha-7")).not.toBeInTheDocument();
    expect(screen.getByText("Needs your input")).toBeInTheDocument();
  });

  it("shows a calm state while keeping all project panels visible", () => {
    const actionItems = [
      makeActionItem({
        session: makeSession({ id: "alpha-1", status: "working", activity: "active" }),
        projectId: "alpha",
        projectName: "Alpha",
        attentionLevel: "working",
        triageRank: 4,
      }),
    ];
    const projectSummaries = [
      makeSummary({
        id: "alpha",
        name: "Alpha",
        sessionCount: 1,
        activeCount: 1,
        attentionCounts: { merge: 0, respond: 0, review: 0, pending: 0, working: 1, done: 0 },
      }),
      makeSummary({ id: "beta", name: "Beta" }),
    ];

    render(<PortfolioPage actionItems={actionItems} projectSummaries={projectSummaries} />);

    expect(screen.getByText("Nothing currently needs human judgment.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Alpha board" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Beta board" })).toBeInTheDocument();
  });

  it("shows a repair state for degraded projects", () => {
    const projectSummaries = [
      makeSummary({
        id: "broken",
        name: "Broken Project",
        degraded: true,
        degradedReason: "Failed to load config at /tmp/broken/agent-orchestrator.yaml",
      }),
    ];

    render(<PortfolioPage actionItems={[]} projectSummaries={projectSummaries} />);

    expect(screen.getByText("Needs repair")).toBeInTheDocument();
    expect(screen.getByText(/Failed to load config/)).toBeInTheDocument();
    expect(screen.getByText("Repair this project")).toBeInTheDocument();
  });

  it("shows a guided first-project state when no projects are available", () => {
    render(<PortfolioPage actionItems={[]} projectSummaries={[]} />);

    expect(screen.getByText("Register your first project")).toBeInTheDocument();
    expect(screen.getByText("ao start")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open setup guide" })).toBeInTheDocument();
  });

  it("opens a mobile project switcher sheet", () => {
    const projectSummaries = [makeSummary({ id: "alpha", name: "Alpha" })];
    render(<PortfolioPage actionItems={[]} projectSummaries={projectSummaries} />);

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });
});

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PortfolioPage } from "@/components/PortfolioPage";
import type { PortfolioProjectSummary } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/DashboardShell", () => ({
  useDashboardShellControls: () => null,
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

describe("PortfolioPage", () => {
  it("renders the launcher-style main page", () => {
    render(
      <PortfolioPage
        projectSummaries={[
          makeSummary({ id: "agent-orchestrator", name: "agent-orchestrator" }),
          makeSummary({ id: "docs", name: "docs" }),
        ]}
      />,
    );

    expect(screen.getByText("Agent Orchestrator")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Clone from URL/i })).toBeInTheDocument();
    expect(screen.getByText("2 workspaces available")).toBeInTheDocument();
  });

  it("shows the zero-workspace state without hiding the launcher actions", () => {
    render(<PortfolioPage projectSummaries={[]} />);

    expect(screen.getByRole("button", { name: /Open project/i })).toBeInTheDocument();
    expect(screen.getByText("0 workspaces available")).toBeInTheDocument();
  });

  it("fires the expected launcher actions", () => {
    const onOpenProject = vi.fn();
    const onCloneFromUrl = vi.fn();

    render(
      <PortfolioPage
        projectSummaries={[makeSummary({ id: "ao", name: "Agent Orchestrator" })]}
        onOpenProject={onOpenProject}
        onCloneFromUrl={onCloneFromUrl}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open project/i }));
    fireEvent.click(screen.getByRole("button", { name: /Clone from URL/i }));

    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onCloneFromUrl).toHaveBeenCalledTimes(1);
  });

  it("shows 1 workspace (singular) label", () => {
    render(
      <PortfolioPage
        projectSummaries={[makeSummary({ id: "ao", name: "AO" })]}
      />,
    );

    expect(screen.getByText("1 workspace available")).toBeInTheDocument();
  });
});

describe("PortfolioPage — AttentionHome (sessions present)", () => {
  const projectsWithSessions: PortfolioProjectSummary[] = [
    makeSummary({
      id: "proj-a",
      name: "Alpha",
      repo: "org/alpha",
      sessionCount: 5,
      activeCount: 3,
      attentionCounts: { merge: 1, respond: 1, review: 0, pending: 1, working: 0, done: 2 },
    }),
    makeSummary({
      id: "proj-b",
      name: "Beta",
      sessionCount: 2,
      activeCount: 0,
      attentionCounts: { merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 2 },
    }),
  ];

  it("renders attention-first layout when sessions exist", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    expect(screen.getByText("Portfolio")).toBeInTheDocument();
    // Should NOT show the launcher hero
    expect(screen.queryByText("Agent Orchestrator")).not.toBeInTheDocument();
  });

  it("displays aggregate stats in header", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    // 3 active of 7 sessions across 2 workspaces
    expect(screen.getByText(/3 active of 7 sessions across 2 workspaces/)).toBeInTheDocument();
  });

  it("shows attention pills for non-zero levels", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    // "1 merge" etc. appear in global pills AND per-project badges
    expect(screen.getAllByText("1 merge").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 respond").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("1 pending").length).toBeGreaterThanOrEqual(1);
    // review count is 0 globally and per-project, should not appear as a pill
    expect(screen.queryByText(/\d+ review/)).not.toBeInTheDocument();
  });

  it("shows 'Fleet is idle' when all active counts are zero", () => {
    const idleProjects = [
      makeSummary({
        id: "idle",
        name: "Idle",
        sessionCount: 1,
        activeCount: 0,
        attentionCounts: { merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 1 },
      }),
    ];
    render(<PortfolioPage projectSummaries={idleProjects} />);

    expect(screen.getByText("All sessions complete. Fleet is idle.")).toBeInTheDocument();
  });

  it("renders project cards with name, session counts, and repo", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // session counts shown as active/total
    expect(screen.getByText("3/5")).toBeInTheDocument();
    expect(screen.getByText("0/2")).toBeInTheDocument();
    // repo shown for Alpha
    expect(screen.getByText("org/alpha")).toBeInTheDocument();
  });

  it("renders attention level badges on project cards", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    // Alpha has merge=1, respond=1, pending=1 — each appears in both global pills and card
    expect(screen.getAllByText("1 merge").length).toBe(2); // global + card
    expect(screen.getAllByText("1 respond").length).toBe(2);
    expect(screen.getAllByText("1 pending").length).toBe(2);
  });

  it("shows Idle on project card with no active attention levels", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    // Beta has no active levels
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("links project cards to project detail pages", () => {
    render(<PortfolioPage projectSummaries={projectsWithSessions} />);

    const alphaLink = screen.getByText("Alpha").closest("a");
    expect(alphaLink).toHaveAttribute("href", "/projects/proj-a");

    const betaLink = screen.getByText("Beta").closest("a");
    expect(betaLink).toHaveAttribute("href", "/projects/proj-b");
  });

  it("uses singular 'workspace' for single project", () => {
    const singleProject = [
      makeSummary({
        id: "solo",
        name: "Solo",
        sessionCount: 1,
        activeCount: 1,
        attentionCounts: { merge: 0, respond: 0, review: 0, pending: 0, working: 1, done: 0 },
      }),
    ];
    render(<PortfolioPage projectSummaries={singleProject} />);

    expect(screen.getByText(/1 active of 1 sessions across 1 workspace$/)).toBeInTheDocument();
  });
});

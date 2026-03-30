import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PortfolioPage } from "@/components/PortfolioPage";
import type { PortfolioProjectSummary } from "@/lib/types";

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
    expect(screen.getByRole("button", { name: /Quick start/i })).toBeInTheDocument();
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
    const onQuickStart = vi.fn();

    render(
      <PortfolioPage
        projectSummaries={[makeSummary({ id: "ao", name: "Agent Orchestrator" })]}
        onOpenProject={onOpenProject}
        onCloneFromUrl={onCloneFromUrl}
        onQuickStart={onQuickStart}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open project/i }));
    fireEvent.click(screen.getByRole("button", { name: /Clone from URL/i }));
    fireEvent.click(screen.getByRole("button", { name: /Quick start/i }));

    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(onCloneFromUrl).toHaveBeenCalledTimes(1);
    expect(onQuickStart).toHaveBeenCalledTimes(1);
  });
});

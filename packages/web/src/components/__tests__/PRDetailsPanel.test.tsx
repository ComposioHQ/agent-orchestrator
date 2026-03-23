import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PRDetailsPanel } from "@/components/PRDetailsPanel";
import type { DashboardPR } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function makePR(overrides: Partial<DashboardPR> = {}): DashboardPR {
  return {
    number: 42,
    url: "https://github.com/org/repo/pull/42",
    title: "Add feature",
    owner: "org",
    repo: "repo",
    branch: "feat/add-feature",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 100,
    deletions: 20,
    ciStatus: "passing",
    ciChecks: [],
    reviewDecision: "approved",
    mergeability: {
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
    ...overrides,
  };
}

describe("PRDetailsPanel", () => {
  it("renders PR title and number", () => {
    render(<PRDetailsPanel pr={makePR()} sessionId="s-1" />);
    expect(screen.getByText("PR #42: Add feature")).toBeInTheDocument();
  });

  it("renders additions and deletions", () => {
    render(<PRDetailsPanel pr={makePR({ additions: 50, deletions: 10 })} sessionId="s-1" />);
    expect(screen.getByText("+50")).toBeInTheDocument();
    expect(screen.getByText("-10")).toBeInTheDocument();
  });

  it("shows ready to merge when all criteria met", () => {
    render(<PRDetailsPanel pr={makePR()} sessionId="s-1" />);
    expect(screen.getByText("Ready to merge")).toBeInTheDocument();
  });

  it("shows blockers when PR is not merge-ready", () => {
    render(
      <PRDetailsPanel
        pr={makePR({
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          ciStatus: "failing",
          ciChecks: [{ name: "test", status: "failed" }],
          reviewDecision: "changes_requested",
        })}
        sessionId="s-1"
      />,
    );
    expect(screen.getByText("Blockers")).toBeInTheDocument();
  });

  it("shows draft badge when PR is draft", () => {
    render(<PRDetailsPanel pr={makePR({ isDraft: true })} sessionId="s-1" />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows merged badge when PR is merged", () => {
    render(
      <PRDetailsPanel
        pr={makePR({ state: "merged" })}
        sessionId="s-1"
      />,
    );
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("renders unresolved comments section", () => {
    render(
      <PRDetailsPanel
        pr={makePR({
          unresolvedThreads: 1,
          unresolvedComments: [
            {
              url: "https://github.com/org/repo/pull/42/comments/1",
              path: "src/index.ts",
              author: "reviewer",
              body: "Please fix this",
            },
          ],
        })}
        sessionId="s-1"
      />,
    );
    expect(screen.getByText("Unresolved Comments")).toBeInTheDocument();
  });
});

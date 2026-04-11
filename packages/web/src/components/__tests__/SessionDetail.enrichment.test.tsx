import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makePR, makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

describe("SessionDetailPRCard enrichment gating", () => {
  it("shows loading text for additions/deletions when PR is not enriched", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "enrich-1",
          projectId: "my-app",
          pr: makePR({
            number: 200,
            title: "Unenriched PR",
            enriched: false,
            additions: 0,
            deletions: 0,
          }),
        })}
      />,
    );

    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByText("+0")).not.toBeInTheDocument();
    expect(screen.queryByText("-0")).not.toBeInTheDocument();
  });

  it("shows fetching message instead of IssuesList when PR is not enriched", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "enrich-2",
          projectId: "my-app",
          pr: makePR({
            number: 201,
            title: "Unenriched blockers",
            enriched: false,
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: false,
              noConflicts: true,
              blockers: [],
            },
            ciStatus: "failing",
            reviewDecision: "none",
          }),
        })}
      />,
    );

    expect(screen.getByText("Fetching CI and review status…")).toBeInTheDocument();
    expect(screen.queryByText(/Not approved/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not mergeable/)).not.toBeInTheDocument();
    expect(screen.queryByText("Blockers")).not.toBeInTheDocument();
  });

  it("shows normal IssuesList when PR is enriched", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "enrich-3",
          projectId: "my-app",
          pr: makePR({
            number: 202,
            title: "Enriched with CI failure",
            enriched: true,
            ciStatus: "failing",
            ciChecks: [
              { name: "build", status: "failed", url: "https://ci.example/build" },
            ],
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: true,
              noConflicts: true,
              blockers: ["CI failing"],
            },
          }),
        })}
      />,
    );

    expect(screen.getByText(/CI failing/)).toBeInTheDocument();
    expect(screen.queryByText("Fetching CI and review status…")).not.toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
  });
});

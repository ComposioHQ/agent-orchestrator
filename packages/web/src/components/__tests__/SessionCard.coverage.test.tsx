import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionCard } from "../SessionCard";
import { makePR, makeSession } from "../../__tests__/helpers";

describe("SessionCard diff coverage", () => {
  it("shows the done-card size shimmer for terminal sessions with unenriched PRs", () => {
    const { container } = render(
      <SessionCard
        session={makeSession({
          id: "done-1",
          status: "merged",
          activity: "exited",
          pr: makePR({
            number: 88,
            title: "Backfill cache-only PR state",
            enriched: false,
          }),
        })}
      />,
    );

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("does not show placeholder PR metrics in the done-card detail panel before enrichment", () => {
    render(
      <SessionCard
        session={makeSession({
          id: "done-2",
          status: "merged",
          activity: "exited",
          pr: makePR({
            number: 89,
            title: "Cold-cache terminal PR",
            additions: 0,
            deletions: 0,
            reviewDecision: "none",
            enriched: false,
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByText("Cold-cache terminal PR"));

    expect(screen.getByText("PR details loading...")).not.toBeNull();
    expect(screen.queryByText("mergeable: no")).toBeNull();
    expect(screen.queryByText("review: none")).toBeNull();
  });

  it("shows enriched PR metrics in the done-card detail panel when data is available", () => {
    render(
      <SessionCard
        session={makeSession({
          id: "done-3",
          status: "merged",
          activity: "exited",
          summary: "Fixed the auth bug",
          pr: makePR({
            number: 90,
            title: "fix: auth token refresh",
            additions: 42,
            deletions: 7,
            reviewDecision: "approved",
            mergeability: {
              mergeable: true,
              ciPassing: true,
              approved: true,
              noConflicts: true,
              blockers: [],
            },
            enriched: true,
          }),
        })}
      />,
    );

    // Click to expand the done card
    fireEvent.click(screen.getByText("fix: auth token refresh"));

    // Enriched PR detail lines 361-377 should render
    expect(screen.getByText("mergeable: yes")).not.toBeNull();
    expect(screen.getByText("review: approved")).not.toBeNull();
    // +42 appears in both meta chips and expanded detail
    expect(screen.getAllByText("+42").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("-7").length).toBeGreaterThanOrEqual(1);
  });
});

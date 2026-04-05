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
});

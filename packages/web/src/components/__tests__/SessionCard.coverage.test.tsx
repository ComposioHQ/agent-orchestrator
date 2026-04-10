import { render } from "@testing-library/react";
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
});

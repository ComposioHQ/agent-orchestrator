import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makePR, makeSession } from "@/__tests__/helpers";
import { SessionCard } from "../SessionCard";

describe("SessionCard shared action predicates", () => {
  it("surfaces the legacy quick prompt payload for CI failures", () => {
    const onSend = vi.fn();
    const session = makeSession({
      activity: "idle",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "test", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI checks failing"],
        },
      }),
    });

    render(<SessionCard session={session} onSend={onSend} />);

    fireEvent.click(screen.getByRole("button", { name: "ask to fix" }));
    expect(onSend).toHaveBeenCalledWith(
      session.id,
      `Please fix the failing CI checks on ${session.pr!.url}`,
    );
  });

  it("hides merge affordances when PR enrichment is rate-limited", () => {
    const session = makeSession({
      status: "mergeable",
      activity: "idle",
      pr: makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: ["API rate limited or unavailable"],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.queryByRole("button", { name: /merge pr/i })).not.toBeInTheDocument();
    expect(screen.getByText("PR data rate limited")).toBeInTheDocument();
  });

  it("keeps restore unavailable for merged sessions", () => {
    const session = makeSession({
      status: "merged",
      activity: "exited",
      pr: makePR({ state: "merged" }),
    });

    render(<SessionCard session={session} />);

    expect(screen.queryByRole("button", { name: "restore" })).not.toBeInTheDocument();
  });
});

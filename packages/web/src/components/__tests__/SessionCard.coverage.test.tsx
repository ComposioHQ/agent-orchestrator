import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCard } from "../SessionCard";
import { makeSession, makePR } from "../../__tests__/helpers";

describe("SessionCard — done card variant", () => {
  it("renders a merged done card with status pill", () => {
    const session = makeSession({
      id: "done-1",
      status: "merged",
      activity: null,
      summary: "Merged feature",
      branch: "feat/merged",
      pr: makePR({ number: 42, state: "merged", title: "Merged PR" }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.getByText("Merged PR")).toBeInTheDocument();
    expect(screen.getByText("feat/merged")).toBeInTheDocument();
    expect(screen.getByText("#42")).toBeInTheDocument();
  });

  it("renders a killed done card", () => {
    const session = makeSession({
      id: "done-killed",
      status: "killed",
      activity: null,
      summary: "Killed session",
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("killed")).toBeInTheDocument();
  });

  it("renders a terminated done card", () => {
    const session = makeSession({
      id: "done-term",
      status: "terminated",
      activity: null,
      summary: "Terminated session",
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("terminated")).toBeInTheDocument();
  });

  it("renders an exited done card with exited label", () => {
    const session = makeSession({
      id: "done-exit",
      status: "done",
      activity: "exited",
      summary: "Exited session",
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("exited")).toBeInTheDocument();
  });

  it("renders default done status when activity is not exited", () => {
    const session = makeSession({
      id: "done-default",
      status: "done",
      activity: null,
      summary: "Done session",
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows restore button on done-but-restorable card (not merged)", () => {
    const onRestore = vi.fn();
    const session = makeSession({
      id: "restorable-1",
      status: "killed",
      activity: null,
      summary: "Restorable session",
    });

    render(<SessionCard session={session} onRestore={onRestore} />);

    const restoreBtn = screen.getByRole("button", { name: /restore/ });
    expect(restoreBtn).toBeInTheDocument();
    fireEvent.click(restoreBtn);
    expect(onRestore).toHaveBeenCalledWith("restorable-1");
  });

  it("does NOT show restore button on merged session", () => {
    const session = makeSession({
      id: "merged-1",
      status: "merged",
      activity: null,
      summary: "Merged - not restorable",
    });

    render(<SessionCard session={session} />);

    expect(screen.queryByRole("button", { name: /restore/ })).not.toBeInTheDocument();
  });

  it("expands done card to show details on click", () => {
    const session = makeSession({
      id: "expand-1",
      status: "killed",
      activity: null,
      summary: "Expand me",
      branch: "feat/expand",
      issueUrl: "https://linear.app/issue/1",
      issueLabel: "INT-1",
      issueTitle: "An issue title",
      pr: makePR({
        number: 99,
        title: "Expand PR",
        ciChecks: [{ name: "build", status: "passed" }],
      }),
    });

    const { container } = render(<SessionCard session={session} />);

    // Click the card to expand
    const cardEl = container.querySelector(".session-card-done")!;
    fireEvent.click(cardEl);

    // Expanded detail should show summary, issue, CI, PR sections
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Issue")).toBeInTheDocument();
    expect(screen.getByText("CI Checks")).toBeInTheDocument();
    expect(screen.getByText("PR")).toBeInTheDocument();
  });

  it("shows 'No PR associated' when done card has no PR", () => {
    const session = makeSession({
      id: "no-pr-1",
      status: "done",
      activity: null,
      summary: "No PR here",
      pr: null,
    });

    const { container } = render(<SessionCard session={session} />);

    // Click to expand
    const cardEl = container.querySelector(".session-card-done")!;
    fireEvent.click(cardEl);

    expect(screen.getByText("No PR associated with this session.")).toBeInTheDocument();
  });

  it("shows PR diff stats with + and - in done card", () => {
    const session = makeSession({
      id: "diff-1",
      status: "done",
      activity: null,
      pr: makePR({ additions: 120, deletions: 30 }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("+120")).toBeInTheDocument();
    expect(screen.getByText("-30")).toBeInTheDocument();
  });
});

describe("SessionCard — active card with alerts", () => {
  it("shows CI failure alert with action button", () => {
    const onSend = vi.fn();
    const session = makeSession({
      id: "alert-ci",
      status: "working",
      activity: "active",
      summary: "CI failing session",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [
          { name: "build", status: "failed", url: "https://ci.example/build" },
          { name: "lint", status: "passed" },
        ],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} onSend={onSend} />);

    expect(screen.getByText(/1 CI check failing/)).toBeInTheDocument();
    expect(screen.getByText("ask to fix")).toBeInTheDocument();
  });

  it("shows multiple CI failure count", () => {
    const session = makeSession({
      id: "alert-ci-multi",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [
          { name: "build", status: "failed" },
          { name: "test", status: "failed" },
          { name: "lint", status: "passed" },
        ],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText(/2 CI checks failing/)).toBeInTheDocument();
  });

  it("shows CI unknown when failing but no failed checks", () => {
    const session = makeSession({
      id: "alert-ci-unknown",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("CI unknown")).toBeInTheDocument();
  });

  it("shows changes requested alert", () => {
    const session = makeSession({
      id: "alert-changes",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("changes requested")).toBeInTheDocument();
    expect(screen.getByText("ask to address")).toBeInTheDocument();
  });

  it("shows needs review alert when review is pending", () => {
    const session = makeSession({
      id: "alert-review",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        isDraft: false,
        reviewDecision: "pending",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("needs review")).toBeInTheDocument();
    expect(screen.getByText("ask to post")).toBeInTheDocument();
  });

  it("shows merge conflict alert", () => {
    const session = makeSession({
      id: "alert-conflict",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: false,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("merge conflict")).toBeInTheDocument();
  });

  it("shows unresolved comments alert with count", () => {
    const session = makeSession({
      id: "alert-comments",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        unresolvedThreads: 3,
        unresolvedComments: [
          { url: "https://github.com/acme/app/pull/1#c1", path: "src/a.ts", author: "bot", body: "Fix this" },
        ],
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("unresolved comments")).toBeInTheDocument();
    expect(screen.getByText("ask to resolve")).toBeInTheDocument();
  });

  it("fires action when alert action button is clicked", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const session = makeSession({
      id: "alert-action",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const askToFix = screen.getByText("ask to fix");
    await act(async () => {
      fireEvent.click(askToFix);
    });

    expect(onSend).toHaveBeenCalledWith("alert-action", expect.stringContaining("fix the failing CI"));
  });
});

describe("SessionCard — quick reply section", () => {
  it("shows quick reply presets for respond-level sessions", () => {
    const session = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need human input",
    });

    render(<SessionCard session={session} onSend={vi.fn()} />);

    expect(screen.getByText("Continue")).toBeInTheDocument();
    expect(screen.getByText("Abort")).toBeInTheDocument();
    expect(screen.getByText("Skip")).toBeInTheDocument();
    expect(screen.getByLabelText("Type a reply to the agent")).toBeInTheDocument();
  });

  it("sends quick reply when preset button is clicked", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const session = makeSession({
      id: "respond-2",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need input",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Continue"));
    });

    expect(onSend).toHaveBeenCalledWith("respond-2", "continue");
  });

  it("sends custom reply on Enter key", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const session = makeSession({
      id: "respond-3",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Custom reply test",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const textarea = screen.getByLabelText("Type a reply to the agent");
    fireEvent.change(textarea, { target: { value: "my custom reply" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    });

    expect(onSend).toHaveBeenCalledWith("respond-3", "my custom reply");
  });

  it("does not send on Shift+Enter (allows newline)", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const session = makeSession({
      id: "respond-4",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Shift enter test",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const textarea = screen.getByLabelText("Type a reply to the agent");
    fireEvent.change(textarea, { target: { value: "multi line" } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows sent state after quick reply succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSend = vi.fn(() => Promise.resolve());
    const session = makeSession({
      id: "respond-5",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Sent state",
    });

    render(<SessionCard session={session} onSend={onSend} />);

    await act(async () => {
      fireEvent.click(screen.getByText("Continue"));
    });

    // After sending succeeds, the button should show "Sent"
    expect(screen.getByText("Sent")).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("shows summary in quick reply when available and not fallback", () => {
    const session = makeSession({
      id: "respond-summary",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Agent is asking about X",
      summaryIsFallback: false,
    });

    render(<SessionCard session={session} onSend={vi.fn()} />);

    // The quick reply section should show the summary
    expect(screen.getAllByText("Agent is asking about X").length).toBeGreaterThanOrEqual(1);
  });
});

describe("SessionCard — action buttons", () => {
  it("shows kill button for active sessions", () => {
    const onKill = vi.fn();
    const session = makeSession({
      id: "active-1",
      status: "working",
      activity: "active",
    });

    render(<SessionCard session={session} onKill={onKill} />);

    const killBtn = screen.getByLabelText("Terminate session");
    fireEvent.click(killBtn);
    expect(onKill).toHaveBeenCalledWith("active-1");
  });

  it("shows merge button when PR is merge-ready", () => {
    const onMerge = vi.fn();
    const session = makeSession({
      id: "merge-1",
      status: "working",
      activity: "active",
      pr: makePR({
        number: 50,
        state: "open",
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} onMerge={onMerge} />);

    const mergeBtn = screen.getByText("merge");
    fireEvent.click(mergeBtn);
    expect(onMerge).toHaveBeenCalledWith(50);
  });

  it("shows restore button for terminal sessions that are not merged", () => {
    const onRestore = vi.fn();
    const session = makeSession({
      id: "restore-1",
      status: "killed",
      activity: null,
    });

    render(<SessionCard session={session} onRestore={onRestore} />);

    const restoreBtn = screen.getByRole("button", { name: /restore/ });
    fireEvent.click(restoreBtn);
    expect(onRestore).toHaveBeenCalledWith("restore-1");
  });

  it("shows terminal link for active sessions", () => {
    const session = makeSession({
      id: "term-link",
      status: "working",
      activity: "active",
    });

    render(<SessionCard session={session} />);

    const link = screen.getByText("terminal");
    expect(link.closest("a")).toHaveAttribute("href", "/sessions/term-link");
  });
});

describe("SessionCard — merge-ready styling", () => {
  it("applies merge-frame class when PR is merge-ready", () => {
    const session = makeSession({
      id: "merge-style",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    const { container } = render(<SessionCard session={session} />);

    expect(container.querySelector(".session-card--merge-frame")).toBeInTheDocument();
    expect(container.querySelector(".card-merge-ready")).toBeInTheDocument();
  });

  it("applies alert-frame class when there are alerts", () => {
    const session = makeSession({
      id: "alert-frame",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    const { container } = render(<SessionCard session={session} />);

    expect(container.querySelector(".session-card--alert-frame")).toBeInTheDocument();
  });
});

describe("SessionCard — rate limited state", () => {
  it("shows rate limited indicator when PR is rate limited", () => {
    const session = makeSession({
      id: "rate-limited",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["API rate limited or unavailable"],
        },
      }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("PR data rate limited")).toBeInTheDocument();
  });

  it("does not show alerts when rate limited", () => {
    const session = makeSession({
      id: "rate-limited-no-alerts",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["API rate limited or unavailable"],
        },
      }),
    });

    render(<SessionCard session={session} />);

    // Alerts should be suppressed
    expect(screen.queryByText(/CI check/)).not.toBeInTheDocument();
  });
});

describe("SessionCard — secondary text", () => {
  it("shows issue label and issue title as secondary text", () => {
    const session = makeSession({
      id: "secondary-1",
      status: "working",
      activity: "active",
      issueLabel: "INT-123",
      issueTitle: "Fix the widget",
      summary: "Different from title",
      pr: makePR({ title: "Different from title" }),
    });

    render(<SessionCard session={session} />);

    expect(screen.getByText("INT-123 · Fix the widget")).toBeInTheDocument();
  });

  it("shows issue URL link in footer", () => {
    const session = makeSession({
      id: "footer-1",
      status: "working",
      activity: "active",
      issueUrl: "https://linear.app/team/issue/INT-1",
      issueLabel: "INT-1",
    });

    render(<SessionCard session={session} />);

    const issueLinks = screen.getAllByText("INT-1");
    const footerLink = issueLinks.find((el) => el.closest("a")?.getAttribute("href") === "https://linear.app/team/issue/INT-1");
    expect(footerLink).toBeDefined();
  });

  it("shows activity or status as fallback when no issue URL", () => {
    const session = makeSession({
      id: "footer-2",
      status: "working",
      activity: "idle",
      issueUrl: null,
      issueLabel: null,
    });

    render(<SessionCard session={session} />);

    // Footer shows "idle" (the activity fallback) - may appear more than once
    const idleElements = screen.getAllByText("idle");
    expect(idleElements.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SessionCard — action failure handling", () => {
  it("shows failed state when action send fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onSend = vi.fn(() => Promise.reject(new Error("fail")));
    const session = makeSession({
      id: "fail-action",
      status: "working",
      activity: "active",
      pr: makePR({
        state: "open",
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed" }],
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      }),
    });

    render(<SessionCard session={session} onSend={onSend} />);

    const askToFix = screen.getByText("ask to fix");
    await act(async () => {
      fireEvent.click(askToFix);
    });

    expect(screen.getByText("failed")).toBeInTheDocument();

    vi.useRealTimers();
  });
});

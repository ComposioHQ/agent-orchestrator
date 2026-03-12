import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CIBadge, CICheckList } from "@/components/CIBadge";
import { PRStatus } from "@/components/PRStatus";
import { SessionCard } from "@/components/SessionCard";
import { AttentionZone } from "@/components/AttentionZone";
import { ActivityDot } from "@/components/ActivityDot";
import { OperatorQueue } from "@/components/OperatorQueue";
import { HarnessPlanPanel } from "@/components/HarnessPlanPanel";
import { QuickCommandDeck } from "@/components/QuickCommandDeck";
import { RecentActivityFeed } from "@/components/RecentActivityFeed";
import { SessionHarnessPanel } from "@/components/SessionHarnessPanel";
import { makeSession, makePR } from "./helpers";

// ── ActivityDot ───────────────────────────────────────────────────────

describe("ActivityDot", () => {
  it("renders label pill with activity name", () => {
    render(<ActivityDot activity="active" />);
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("renders all known activity states", () => {
    const states = ["active", "ready", "idle", "waiting_input", "blocked", "exited"] as const;
    for (const state of states) {
      const { unmount } = render(<ActivityDot activity={state} />);
      const expected = state === "waiting_input" ? "waiting" : state;
      expect(screen.getByText(expected)).toBeInTheDocument();
      unmount();
    }
  });

  it("renders unknown activity state with raw label", () => {
    render(<ActivityDot activity="some_future_state" />);
    expect(screen.getByText("some_future_state")).toBeInTheDocument();
  });

  it("renders null activity with 'unknown' label", () => {
    render(<ActivityDot activity={null} />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });

  it("renders only a dot in dotOnly mode (no label)", () => {
    render(<ActivityDot activity="active" dotOnly />);
    // No label text should appear in dotOnly mode
    expect(screen.queryByText("active")).not.toBeInTheDocument();
  });
});

// ── CIBadge ──────────────────────────────────────────────────────────

describe("CIBadge", () => {
  it("renders passing status", () => {
    render(<CIBadge status="passing" />);
    expect(screen.getByText("CI passing")).toBeInTheDocument();
  });

  it("renders failing status with check count", () => {
    const checks = [
      { name: "build", status: "failed" as const },
      { name: "test", status: "failed" as const },
      { name: "lint", status: "passed" as const },
    ];
    render(<CIBadge status="failing" checks={checks} />);
    expect(screen.getByText("2 checks failing")).toBeInTheDocument();
  });

  it("renders single failing check without plural", () => {
    const checks = [
      { name: "build", status: "failed" as const },
      { name: "lint", status: "passed" as const },
    ];
    render(<CIBadge status="failing" checks={checks} />);
    expect(screen.getByText("1 check failing")).toBeInTheDocument();
  });

  it("renders pending status", () => {
    render(<CIBadge status="pending" />);
    expect(screen.getByText("CI pending")).toBeInTheDocument();
  });

  it("renders em-dash for none status", () => {
    const { container } = render(<CIBadge status="none" />);
    expect(container.textContent).toContain("—");
  });

  it("hides icon in compact mode", () => {
    const { container } = render(<CIBadge status="passing" compact />);
    // In compact mode, no icon span before the label
    const spans = container.querySelectorAll("span > span");
    // Should only have the label text, no extra icon span
    expect(spans.length).toBe(0);
  });
});

// ── CICheckList ──────────────────────────────────────────────────────

describe("CICheckList", () => {
  it("renders all checks", () => {
    const checks = [
      { name: "build", status: "passed" as const },
      { name: "test", status: "failed" as const, url: "https://example.com/test" },
      { name: "lint", status: "pending" as const },
    ];
    render(<CICheckList checks={checks} />);
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("sorts failed checks first", () => {
    const checks = [
      { name: "lint", status: "passed" as const },
      { name: "build", status: "failed" as const },
      { name: "test", status: "running" as const },
    ];
    const { container } = render(<CICheckList checks={checks} />);
    const names = Array.from(container.querySelectorAll(".truncate")).map((el) => el.textContent);
    expect(names[0]).toBe("build"); // failed first
    expect(names[1]).toBe("test"); // running second
    expect(names[2]).toBe("lint"); // passed last
  });

  it("renders view links for checks with URLs", () => {
    const checks = [
      { name: "build", status: "passed" as const, url: "https://example.com/build" },
      { name: "test", status: "passed" as const },
    ];
    render(<CICheckList checks={checks} />);
    const links = screen.getAllByText("view");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/build");
  });
});

// ── PRStatus ─────────────────────────────────────────────────────────

describe("PRStatus", () => {
  it("renders PR number as link", () => {
    const pr = makePR({ number: 42 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("#42").closest("a")).toHaveAttribute("href", pr.url);
  });

  it("renders size label", () => {
    const pr = makePR({ additions: 50, deletions: 10 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("+50 -10 S")).toBeInTheDocument();
  });

  it("computes XL size label for large PRs", () => {
    const pr = makePR({ additions: 800, deletions: 300 });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("+800 -300 XL")).toBeInTheDocument();
  });

  it("shows merged badge for merged PRs", () => {
    const pr = makePR({ state: "merged" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("merged")).toBeInTheDocument();
  });

  it("shows draft badge for draft PRs", () => {
    const pr = makePR({ isDraft: true, state: "open" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("shows approved badge", () => {
    const pr = makePR({ reviewDecision: "approved", state: "open" });
    render(<PRStatus pr={pr} />);
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("does not show CI badge for draft PRs", () => {
    const pr = makePR({ isDraft: true, state: "open", ciStatus: "passing" });
    render(<PRStatus pr={pr} />);
    expect(screen.queryByText("CI passing")).not.toBeInTheDocument();
  });

  it("does not show CI badge for merged PRs", () => {
    const pr = makePR({ state: "merged", ciStatus: "passing" });
    render(<PRStatus pr={pr} />);
    expect(screen.queryByText("CI passing")).not.toBeInTheDocument();
  });
});

// ── SessionCard ──────────────────────────────────────────────────────

describe("SessionCard", () => {
  it("renders session id and summary", () => {
    const session = makeSession({ id: "backend-1", summary: "Fixing auth" });
    render(<SessionCard session={session} />);
    expect(screen.getByText("backend-1")).toBeInTheDocument();
    expect(screen.getByText("Fixing auth")).toBeInTheDocument();
  });

  it("shows PR title instead of summary when PR exists", () => {
    const pr = makePR({ title: "feat: add auth" });
    const session = makeSession({ summary: "Fixing auth", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("feat: add auth")).toBeInTheDocument();
  });

  it("renders branch name", () => {
    const session = makeSession({ branch: "feat/cool-thing" });
    render(<SessionCard session={session} />);
    expect(screen.getByText("feat/cool-thing")).toBeInTheDocument();
  });

  it("renders terminal link", () => {
    const session = makeSession({ id: "backend-5" });
    render(<SessionCard session={session} />);
    const link = screen.getByText("terminal");
    expect(link).toHaveAttribute("href", "/sessions/backend-5");
  });

  it("shows restore button when agent has exited", () => {
    const session = makeSession({ activity: "exited" });
    render(<SessionCard session={session} />);
    // Header shows compact "restore"; expanded panel shows "restore session"
    expect(screen.getByText("restore")).toBeInTheDocument();
  });

  it("does not show restore button when agent is active", () => {
    const session = makeSession({ activity: "active" });
    render(<SessionCard session={session} />);
    expect(screen.queryByText("restore")).not.toBeInTheDocument();
  });

  it("calls onRestore when restore button is clicked", () => {
    const onRestore = vi.fn();
    const session = makeSession({ id: "backend-1", activity: "exited" });
    render(<SessionCard session={session} onRestore={onRestore} />);
    // Click the header "restore" button (always visible)
    fireEvent.click(screen.getByText("restore"));
    expect(onRestore).toHaveBeenCalledWith("backend-1");
  });

  it("shows merge button when PR is mergeable", () => {
    const pr = makePR({
      number: 42,
      state: "open",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("Merge PR #42")).toBeInTheDocument();
  });

  it("calls onMerge when merge button is clicked", () => {
    const onMerge = vi.fn();
    const pr = makePR({
      number: 42,
      state: "open",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "mergeable", activity: "idle", pr });
    render(<SessionCard session={session} onMerge={onMerge} />);
    fireEvent.click(screen.getByText("Merge PR #42"));
    expect(onMerge).toHaveBeenCalledWith(42);
  });

  it("shows CI failing alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [
        { name: "build", status: "passed" },
        { name: "test", status: "failed" },
      ],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ status: "ci_failed", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("1 CI check failing")).toBeInTheDocument();
  });

  it("shows CI status unknown when ciStatus is failing but no failed checks", () => {
    // This happens when GitHub API fails - getCISummary returns "failing"
    // but getCIChecks returns empty array
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [], // Empty - API failed to fetch checks
      reviewDecision: "none",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI is failing"],
      },
    });
    const session = makeSession({ status: "ci_failed", activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("CI unknown")).toBeInTheDocument();
    // Should NOT show "0 CI check failing"
    expect(screen.queryByText(/0.*CI check.*failing/i)).not.toBeInTheDocument();
    // Should NOT show "ask to fix" action for unknown CI
    expect(screen.queryByText("ask to fix")).not.toBeInTheDocument();
  });

  it("shows changes requested alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "changes_requested",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("changes requested")).toBeInTheDocument();
  });

  it("shows needs review alert", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "pending",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("needs review")).toBeInTheDocument();
  });

  it("shows unresolved comments alert with count", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "passing",
      reviewDecision: "approved",
      unresolvedThreads: 3,
      unresolvedComments: [
        { url: "https://example.com/1", path: "src/a.ts", author: "alice", body: "fix" },
        { url: "https://example.com/2", path: "src/b.ts", author: "bob", body: "fix" },
        { url: "https://example.com/3", path: "src/c.ts", author: "carol", body: "fix" },
      ],
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("unresolved comments")).toBeInTheDocument();
  });

  it("shows action buttons when agent is idle", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "idle", pr });
    render(<SessionCard session={session} />);
    expect(screen.getByText("ask to fix")).toBeInTheDocument();
  });

  it("hides action buttons when agent is active", () => {
    const pr = makePR({
      state: "open",
      ciStatus: "failing",
      ciChecks: [{ name: "test", status: "failed" }],
      reviewDecision: "approved",
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    const session = makeSession({ activity: "active", pr });
    render(<SessionCard session={session} />);
    expect(screen.queryByText("ask to fix")).not.toBeInTheDocument();
  });

  it("expands detail panel on click", () => {
    const session = makeSession({ id: "test-1", issueId: "INT-100", pr: null });
    const { container } = render(<SessionCard session={session} />);
    expect(screen.queryByText("INT-100")).not.toBeInTheDocument();
    // Click the card (not a button/link)
    fireEvent.click(container.firstElementChild!);
    expect(screen.getByText("INT-100")).toBeInTheDocument();
    expect(screen.getByText("No PR associated with this session.")).toBeInTheDocument();
  });

  it("shows terminate button in expanded view", () => {
    const session = makeSession({ pr: null });
    const { container } = render(<SessionCard session={session} />);
    fireEvent.click(container.firstElementChild!);
    expect(screen.getByText("terminate")).toBeInTheDocument();
  });
});

describe("OperatorQueue", () => {
  it("renders merge-ready action first", () => {
    const mergeSession = makeSession({
      id: "merge-1",
      status: "mergeable",
      activity: "idle",
      pr: makePR(),
    });
    const respondSession = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      pr: null,
    });
    render(<OperatorQueue sessions={[respondSession, mergeSession]} />);
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Merge #100");
  });

  it("calls onSend for respond action", async () => {
    const onSend = vi.fn();
    const respondSession = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      pr: null,
    });
    render(<OperatorQueue sessions={[respondSession]} onSend={onSend} />);
    fireEvent.click(screen.getAllByText("Send unblock")[0]);
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        "respond-1",
        expect.stringContaining("State the blocker"),
      );
    });
  });
});

describe("HarnessPlanPanel", () => {
  it("renders focus work and action labels", () => {
    render(
      <HarnessPlanPanel
        items={[
          {
            work_id: "TKT-20260310-001",
            work_status: "needs_input",
            next_action: "escalate",
            priority: 95,
            reason: "ticket is blocked and requires operator input",
          },
          {
            work_id: "TKT-20260310-002",
            work_status: "queued",
            next_action: "dispatch",
            priority: 70,
            reason: "ticket is eligible for scheduling",
          },
        ]}
        workState={[
          { work_id: "TKT-20260310-001", work_status: "needs_input" },
          { work_id: "TKT-20260310-002", work_status: "queued" },
        ]}
        reconciliationState={[
          {
            work_id: "TKT-20260310-001",
            next_action: "reconcile_session",
          },
        ]}
      />,
    );
    expect(screen.getByText("Harness Plan")).toBeInTheDocument();
    expect(screen.getByText("Focus Work")).toBeInTheDocument();
    expect(screen.getAllByText("escalate")[0]).toBeInTheDocument();
    expect(screen.getByText("dispatch")).toBeInTheDocument();
    expect(screen.getByText("2 tracked work")).toBeInTheDocument();
    expect(screen.getByText("1 needs reconcile")).toBeInTheDocument();
  });
});

describe("SessionHarnessPanel", () => {
  it("renders work, reconciliation, and dispatch authority", () => {
    render(
      <SessionHarnessPanel
        harness={{
          workId: "TKT-20260310-001",
          workState: {
            work_id: "TKT-20260310-001",
            work_status: "review",
            retry_count: 1,
            retry_budget: 3,
          },
          reconciliation: {
            work_id: "TKT-20260310-001",
            next_action: "reconcile_session",
            reason: "runtime exited during verification",
          },
          dispatchPlan: {
            work_id: "TKT-20260310-001",
            work_status: "review",
            next_action: "operator_review",
            priority: 92,
            reason: "human review required before merge",
          },
        }}
      />,
    );
    expect(screen.getByText("Work Authority")).toBeInTheDocument();
    expect(screen.getByText("TKT-20260310-001")).toBeInTheDocument();
    expect(screen.getAllByText("review")).toHaveLength(2);
    expect(screen.getByText("reconcile")).toBeInTheDocument();
    expect(screen.getByText("priority 92")).toBeInTheDocument();
  });
});

describe("QuickCommandDeck", () => {
  it("sends preset messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<QuickCommandDeck session={makeSession({ id: "backend-1", pr: makePR() })} />);
    fireEvent.click(screen.getByText("Summarize State"));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/backend-1/message",
        expect.objectContaining({ method: "POST" }),
      );
    });
    vi.unstubAllGlobals();
  });

  it("adapts commands to blocked sessions", () => {
    render(
      <QuickCommandDeck
        session={makeSession({
          id: "backend-2",
          status: "needs_input",
          activity: "waiting_input",
          pr: makePR({
            ciStatus: "failing",
            reviewDecision: "changes_requested",
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: false,
              noConflicts: true,
              blockers: ["CI is failing"],
            },
          }),
        })}
      />,
    );
    expect(screen.getByText("Unblock Session")).toBeInTheDocument();
    expect(screen.getByText("Fix Failing CI")).toBeInTheDocument();
  });
});

describe("RecentActivityFeed", () => {
  it("records transitions as props change", () => {
    const { rerender } = render(
      <RecentActivityFeed status="working" activity="active" lastActivityAt="2026-03-10T10:00:00Z" />,
    );
    rerender(
      <RecentActivityFeed status="needs_input" activity="waiting_input" lastActivityAt="2026-03-10T10:05:00Z" />,
    );
    expect(screen.getByText("needs input")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });
});

// ── AttentionZone ────────────────────────────────────────────────────

describe("AttentionZone", () => {
  it("renders zone label and session count", () => {
    const sessions = [makeSession({ id: "s1" }), makeSession({ id: "s2" })];
    render(<AttentionZone level="respond" sessions={sessions} />);
    // Labels use CSS text-transform:uppercase but DOM text is title-cased
    expect(screen.getByText("Respond")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders nothing when sessions array is empty", () => {
    const { container } = render(<AttentionZone level="respond" sessions={[]} />);
    expect(container.firstElementChild).toBeNull();
  });

  it("shows session cards when not collapsed", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="respond" sessions={sessions} />);
    // respond is defaultCollapsed: false, so cards should be visible
    expect(screen.getByText("s1")).toBeInTheDocument();
  });

  it("working zone is collapsed by default", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="working" sessions={sessions} />);
    // working is defaultCollapsed: false (Kanban always shows), so sessions visible
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("done zone is collapsed by default", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="done" sessions={sessions} />);
    // done is defaultCollapsed: true, so session id should not be visible
    expect(screen.queryByText("s1")).not.toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("toggles collapsed state on click", () => {
    const sessions = [makeSession({ id: "s1" })];
    render(<AttentionZone level="done" sessions={sessions} />);
    // done starts collapsed
    expect(screen.queryByText("s1")).not.toBeInTheDocument();

    // Click the zone header to expand
    fireEvent.click(screen.getByText("Done"));
    expect(screen.getByText("s1")).toBeInTheDocument();

    // Click again to collapse
    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByText("s1")).not.toBeInTheDocument();
  });

  it("passes callbacks to SessionCards", () => {
    const onRestore = vi.fn();
    const sessions = [makeSession({ id: "s1", activity: "exited" })];
    render(<AttentionZone level="respond" sessions={sessions} onRestore={onRestore} />);
    fireEvent.click(screen.getByText("restore"));
    expect(onRestore).toHaveBeenCalledWith("s1");
  });
});

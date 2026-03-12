import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession, DispatchPlanItem, HarnessSnapshot } from "@/lib/types";
import { makePR, makeSession } from "./helpers";

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: (sessions: DashboardSession[]) => sessions,
}));

vi.mock("@/components/DynamicFavicon", () => ({
  DynamicFavicon: () => null,
}));

vi.mock("@/components/DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => <div>terminal:{sessionId}</div>,
}));

const emptyHarness: HarnessSnapshot = {
  dispatchPlan: [],
  workState: [],
  reconciliationState: [],
  scoreSummaryByTicket: [],
  needsRescore: [],
};

const stats = {
  totalSessions: 1,
  workingSessions: 1,
  openPRs: 1,
  needsReview: 0,
};

function mockOkFetch() {
  const fn = vi.fn(async () => ({
    ok: true,
    text: async () => "",
    json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("Dashboard controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatch action button posts /api/spawn with project and issue", async () => {
    const fetchMock = mockOkFetch();
    const dispatchPlan: DispatchPlanItem[] = [
      {
        work_id: "TKT-1",
        work_status: "todo",
        next_action: "dispatch",
        priority: 100,
        reason: "ready",
      },
    ];

    render(
      <Dashboard
        initialSessions={[]}
        dispatchPlan={dispatchPlan}
        harness={emptyHarness}
        stats={stats}
        defaultProjectId="agent-orchestrator"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "dispatch" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ projectId: "agent-orchestrator", issueId: "TKT-1" }),
        }),
      );
    });
  });

  it("fallback sessions allow send/kill/restore/merge and target correct endpoints", async () => {
    const fetchMock = mockOkFetch();
    const mergeablePr = makePR({ number: 777 });
    const session = makeSession({
      id: "sess-merge",
      status: "approved",
      activity: "exited",
      issueTitle: "Merge candidate",
      pr: mergeablePr,
    });

    render(
      <Dashboard
        initialSessions={[session]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "merge" }));
    fireEvent.click(await screen.findByRole("button", { name: "restore" }));
    fireEvent.click(await screen.findByRole("button", { name: "kill" }));
    fireEvent.click(await screen.findByRole("button", { name: "send" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/prs/777/merge", expect.objectContaining({ method: "POST" }));
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess-merge/restore", expect.objectContaining({ method: "POST" }));
      expect(fetchMock).toHaveBeenCalledWith("/api/sessions/sess-merge/kill", expect.objectContaining({ method: "POST" }));
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess-merge/send",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("review action routes to orchestrator session", async () => {
    const fetchMock = mockOkFetch();
    const reviewSession = makeSession({
      id: "sess-review",
      status: "ci_failed",
      activity: "idle",
      issueTitle: "Needs review",
      pr: makePR({
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["ci failed"],
        },
      }),
    });

    render(
      <Dashboard
        initialSessions={[reviewSession]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
        orchestratorId="orch-1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "review" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/orch-1/send",
        expect.objectContaining({ method: "POST" }),
      );
    });

  });

  it("hold action routes to orchestrator session", async () => {
    const fetchMock = mockOkFetch();
    const pendingSession = makeSession({
      id: "sess-pending",
      status: "working",
      activity: "active",
      issueTitle: "Pending task",
      pr: null,
    });

    render(
      <Dashboard
        initialSessions={[pendingSession]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
        orchestratorId="orch-1"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "hold" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/orch-1/send",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("control inbox click switches selected work", async () => {
    mockOkFetch();
    const dispatchPlan: DispatchPlanItem[] = [
      {
        work_id: "TKT-A",
        work_status: "in_progress",
        next_action: "send",
        priority: 100,
        reason: "first",
      },
      {
        work_id: "TKT-B",
        work_status: "blocked",
        next_action: "review",
        priority: 60,
        reason: "needs reconcile after policy check",
      },
    ];

    render(
      <Dashboard
        initialSessions={[]}
        dispatchPlan={dispatchPlan}
        harness={emptyHarness}
        stats={stats}
      />,
    );

    await screen.findByRole("heading", { level: 1, name: "TKT-A" });
    const reconcileLabel = screen.getByText("Needs Reconcile");
    fireEvent.click(reconcileLabel.closest("button") as HTMLButtonElement);
    await screen.findByRole("heading", { level: 1, name: "TKT-B" });
  });

  it("maps all inbox cards to distinct real-data style works", async () => {
    mockOkFetch();
    const mergeSession = makeSession({
      id: "sess-merge-ready",
      issueTitle: "Merge ready session",
      activity: "idle",
      pr: makePR({ number: 909 }),
    });

    const dispatchPlan: DispatchPlanItem[] = [
      {
        work_id: "W-FOCUS",
        work_status: "ready",
        next_action: "dispatch",
        priority: 100,
        reason: "top priority dispatch",
      },
      {
        work_id: "W-DECISION",
        work_status: "review",
        next_action: "kill",
        priority: 90,
        reason: "operator must decide whether to kill",
      },
      {
        work_id: "W-INPUT",
        work_status: "needs_input",
        next_action: "send",
        priority: 80,
        reason: "waiting for human input",
      },
      {
        work_id: "W-BLOCKED",
        work_status: "blocked",
        next_action: "hold",
        priority: 70,
        reason: "blocked by policy SEC-001",
      },
      {
        work_id: "W-MERGE",
        work_status: "approved",
        next_action: "merge",
        priority: 60,
        reason: "ready to merge after approval",
      },
      {
        work_id: "W-RECONCILE",
        work_status: "review",
        next_action: "review",
        priority: 50,
        reason: "needs reconcile on runtime exit",
      },
    ];

    const harness: HarnessSnapshot = {
      dispatchPlan,
      workState: [
        { work_id: "W-MERGE", work_status: "approved", active_session_id: "sess-merge-ready" },
      ],
      reconciliationState: [
        { work_id: "W-FOCUS", next_action: "dispatch", reason: "top priority dispatch" },
        { work_id: "W-DECISION", next_action: "kill", reason: "operator must decide whether to kill" },
        { work_id: "W-INPUT", next_action: "send", reason: "waiting for human input" },
        { work_id: "W-BLOCKED", next_action: "hold", reason: "blocked by policy SEC-001" },
        { work_id: "W-MERGE", next_action: "merge", reason: "ready to merge after approval", active_session_id: "sess-merge-ready" },
        { work_id: "W-RECONCILE", next_action: "review", reason: "needs reconcile on runtime exit" },
      ],
      scoreSummaryByTicket: [],
      needsRescore: [],
    };

    render(
      <Dashboard
        initialSessions={[mergeSession]}
        dispatchPlan={dispatchPlan}
        harness={harness}
        stats={{ totalSessions: 1, workingSessions: 0, openPRs: 1, needsReview: 1 }}
      />,
    );

    const buttonFor = (label: string) =>
      screen.getByText(label).closest("button") as HTMLButtonElement;

    expect(buttonFor("Focus Work")).toHaveTextContent("W-FOCUS");
    expect(buttonFor("Needs Decision")).toHaveTextContent("W-DECISION");
    expect(buttonFor("Needs Input")).toHaveTextContent("W-INPUT");
    expect(buttonFor("Blocked by Policy")).toHaveTextContent("W-BLOCKED");
    expect(buttonFor("Merge Ready")).toHaveTextContent("W-MERGE");
    expect(buttonFor("Needs Reconcile")).toHaveTextContent("W-RECONCILE");
  });

  it("run command: dispatch uses provided issue id even when no work exists", async () => {
    const fetchMock = mockOkFetch();

    render(
      <Dashboard
        initialSessions={[]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
        defaultProjectId="agent-orchestrator"
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/dispatch 123/i), {
      target: { value: "dispatch ISSUE-99" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run command/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ projectId: "agent-orchestrator", issueId: "ISSUE-99" }),
        }),
      );
    });
    expect(screen.getByText(/state=spawned/i)).toBeInTheDocument();
  });

  it("run command: act calls action endpoint for selected work", async () => {
    const fetchMock = mockOkFetch();
    const session = makeSession({
      id: "sess-act",
      issueTitle: "Action work",
      status: "needs_input",
      activity: "waiting_input",
      pr: null,
    });

    render(
      <Dashboard
        initialSessions={[session]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/dispatch 123/i), {
      target: { value: "act sess-act send" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run command/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/sess-act/send",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("run command: unknown command yields error answer", async () => {
    mockOkFetch();
    const session = makeSession({
      id: "sess-err",
      issueTitle: "Err work",
      status: "needs_input",
      activity: "waiting_input",
      pr: null,
    });

    render(
      <Dashboard
        initialSessions={[session]}
        dispatchPlan={[]}
        harness={emptyHarness}
        stats={stats}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/dispatch 123/i), {
      target: { value: "bogus" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run command/i }));

    await screen.findByText(/state=error/i);
    expect(screen.getByText(/Unknown command/i)).toBeInTheDocument();
  });
});

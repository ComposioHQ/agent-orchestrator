import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makePR, makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/sessions/worker-desktop",
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

function mockDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("SessionDetail desktop layout", () => {
  beforeEach(() => {
    mockDesktopViewport();
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    window.cancelAnimationFrame = vi.fn();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the desktop shell, PR blockers, and unresolved comments", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-desktop",
          projectId: "my-app",
          summary: "Desktop session detail",
          branch: "feat/desktop-detail",
          pr: makePR({
            number: 310,
            title: "Desktop detail coverage",
            branch: "feat/desktop-detail",
            additions: 18,
            deletions: 4,
            ciStatus: "pending",
            ciChecks: [
              { name: "build", status: "failed" },
              { name: "lint", status: "pending" },
              { name: "typecheck", status: "queued" },
            ],
            reviewDecision: "changes_requested",
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: false,
              noConflicts: false,
              blockers: [],
            },
            changedFiles: 3,
            isDraft: true,
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/310#discussion_r1",
                path: "packages/web/src/components/SessionDetail.tsx",
                author: "bugbot",
                body: "### Tighten the copy\n<!-- DESCRIPTION START -->The empty state text needs to be shorter.<!-- DESCRIPTION END -->",
              },
            ],
          }),
          metadata: {
            status: "changes_requested",
            lastMergeConflictDispatched: "true",
            lastPendingReviewDispatchHash: "review-hash",
          },
        })}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
        sidebarSessions={[makeSession({ id: "sidebar-1" })]}
      />,
    );

    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
    expect(screen.getAllByText("My App").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: "Orchestrator" })).toHaveAttribute(
      "href",
      "/sessions/my-app-orchestrator",
    );
    expect(screen.getByRole("link", { name: "feat/desktop-detail" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/tree/feat/desktop-detail",
    );
    expect(screen.getByRole("link", { name: "PR #310" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/100",
    );
    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/Changes requested/i)).toBeInTheDocument();
    expect(screen.getByText(/Merge conflicts/i)).toBeInTheDocument();
    expect(screen.getByText(/Unresolved Comments/i)).toBeInTheDocument();
    expect(screen.getByText("Tighten the copy")).toBeInTheDocument();
    expect(screen.getByText("The empty state text needs to be shorter.")).toBeInTheDocument();
    expect(screen.getByText("Live Terminal")).toBeInTheDocument();
  });

  it("sends unresolved comments back to the agent and shows sent state", async () => {
    vi.useFakeTimers();

    render(
      <SessionDetail
        session={makeSession({
          id: "worker-fix",
          projectId: "my-app",
          pr: makePR({
            number: 311,
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/311#discussion_r2",
                path: "packages/web/src/components/Skeleton.tsx",
                author: "bugbot",
                body: "### Improve empty state\n<!-- DESCRIPTION START -->Use a stronger CTA label.<!-- DESCRIPTION END -->",
              },
            ],
          }),
        })}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask Agent to Fix" }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/worker-fix/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.stringContaining("Improve empty state"),
    });
    expect(screen.getByRole("button", { name: /Sent/i })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByRole("button", { name: "Ask Agent to Fix" })).toBeInTheDocument();
  });

  it("shows terminal-ended placeholder for exited desktop sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-ended",
          projectId: "my-app",
          status: "terminated",
          activity: "exited",
          pr: null,
        })}
      />,
    );

    expect(screen.getByText(/Terminal session has ended/i)).toBeInTheDocument();
    expect(screen.queryByTestId("direct-terminal")).not.toBeInTheDocument();
  });

  it("renders the orchestrator header immediately even when zones are undefined", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Orchestrator session",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={undefined}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getAllByText("Orchestrator session").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("agents")).toBeInTheDocument();
    expect(screen.getByText("Live Terminal")).toBeInTheDocument();
  });

  it("shows skeleton placeholders for orchestrator zones while loading", () => {
    const { container } = render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Loading zones test",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={undefined}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    const headerSide = container.querySelector(".session-detail-identity__actions--custom");
    expect(headerSide).toBeInTheDocument();
    const bones = headerSide?.querySelectorAll(".animate-pulse");
    expect(bones?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("fills in orchestrator zone counts when data arrives", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Zones loaded test",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={{ merge: 1, respond: 0, review: 2, pending: 0, working: 3, done: 0 }}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();
    expect(screen.getByText("merge-ready")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("keeps the orchestrator header aligned and shows an empty state when all zones are zero", () => {
    const { container } = render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          summary: "Idle orchestrator",
          branch: null,
          createdAt: new Date().toISOString(),
        })}
        isOrchestrator
        orchestratorZones={{ merge: 0, respond: 0, review: 0, pending: 0, working: 0, done: 0 }}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("no active agents")).toBeInTheDocument();

    const contentMain = container.querySelector(".session-detail-layout > main");
    const topStrip = container.querySelector(".session-detail-top-strip");
    expect(contentMain).toContainElement(topStrip);
    expect(topStrip?.parentElement).toBe(contentMain);
  });
});

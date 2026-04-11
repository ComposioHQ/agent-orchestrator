import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { makePR, makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("Dashboard mobile layout", () => {
  beforeEach(() => {
    mockMobileViewport();
    Element.prototype.scrollIntoView = vi.fn();
    const eventSourceMock = {
      onmessage: null,
      onerror: null,
      onopen: null,
      close: vi.fn(),
    };
    const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  it("shows all sessions in the mobile feed without row caps", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession({
        id: `needs-input-${index + 1}`,
        summary: `Need approval ${index + 1}`,
        branch: null,
        status: "needs_input",
        activity: "waiting_input",
      }),
    );

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.getByText("Need approval 1")).toBeInTheDocument();
    expect(screen.getByText("Need approval 5")).toBeInTheDocument();
    expect(screen.getByText("Need approval 6")).toBeInTheDocument();
  });

  it("opens a preview sheet from a mobile feed card", async () => {
    const session = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
      branch: "feat/mobile-density",
      issueLabel: "#557",
    });

    render(<Dashboard initialSessions={[session]} />);

    const feedCard = screen.getByRole("button", { name: /respond-1/i });
    expect(feedCard).toBeInTheDocument();
    expect(screen.getByText("feat/mobile-density")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(feedCard);
    });

    expect(screen.getByRole("link", { name: "Open session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminate" })).toBeInTheDocument();
  });

  it("keeps the mobile preview sheet in sync with live session updates", async () => {
    const session = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
      branch: "feat/mobile-density",
      issueLabel: "#557",
    });

    const { rerender } = render(<Dashboard initialSessions={[session]} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /respond-1/i }));
    });

    expect(screen.getByRole("button", { name: "Terminate" })).toBeInTheDocument();

    rerender(
      <Dashboard
        initialSessions={[
          {
            ...session,
            status: "terminated",
            activity: "exited",
            pr: makePR({ number: 87, state: "merged", reviewDecision: "approved" }),
          },
        ]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Terminate" })).not.toBeInTheDocument();
    expect(screen.getAllByText("terminated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("exited").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
  });

  it("does not render embedded PR cards on the dashboard anymore", () => {
    const sessions = [
      makeSession({
        id: "merge-1",
        status: "approved",
        pr: makePR({ number: 87, title: "Add login flow" }),
      }),
    ];

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.queryByRole("link", { name: /#87 add login flow/i })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=all");
  });

  it("renders the mobile bottom nav with dashboard, PRs, and orchestrator", () => {
    render(
      <Dashboard
        initialSessions={[makeSession()]}
        projectId="my-app"
        orchestrators={[
          { id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" },
        ]}
      />,
    );

    expect(screen.getByRole("navigation", { name: /dashboard navigation/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=my-app");
    expect(screen.getByRole("link", { name: "Orchestrator" })).toHaveAttribute(
      "href",
      "/sessions/my-app-orchestrator",
    );
  });

  it("hides orchestrator nav item in all-projects view", () => {
    render(
      <Dashboard
        initialSessions={[makeSession()]}
        projects={[{ id: "my-app", name: "My App" }, { id: "docs", name: "Docs" }]}
      />,
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/?project=all");
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=all");
    expect(screen.queryByRole("link", { name: "Orchestrator" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orchestrator" })).not.toBeInTheDocument();
  });

  it("routes the PR nav item to the dedicated PR page", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "merge-2",
            status: "approved",
            pr: makePR({ number: 91, title: "Polish mobile nav" }),
          }),
        ]}
        projectId="my-app"
      />,
    );

    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute(
      "href",
      "/prs?project=my-app",
    );
  });

  it("filters the mobile board by selected attention bucket", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Working" }));

    expect(screen.getByText("Implement dashboard filters")).toBeInTheDocument();
    expect(screen.queryByText("Need approval to proceed")).not.toBeInTheDocument();
  });

  it("shows empty state when a filtered feed has no matching sessions", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ready" }));

    expect(screen.getByText("No sessions match this filter.")).toBeInTheDocument();
  });

  it("shows CI and review pills for enriched PRs in the mobile feed", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "merge-7",
            status: "approved",
            activity: "idle",
            summary: "Ship dashboard polish",
            branch: "feat/dashboard-polish",
            pr: makePR({
              number: 207,
              additions: 24,
              deletions: 7,
              ciStatus: "failing",
              reviewDecision: "changes_requested",
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("feat/dashboard-polish")).toBeInTheDocument();
    expect(screen.getByText("#207")).toBeInTheDocument();
    expect(screen.getByText("CI failed")).toBeInTheDocument();
    expect(screen.getByText("changes requested")).toBeInTheDocument();
    expect(screen.getByText("+24")).toBeInTheDocument();
    expect(screen.getByText("-7")).toBeInTheDocument();
  });

  it("shows and dismisses the rate limit banner", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "review-2",
            status: "reviewing",
            activity: "idle",
            pr: makePR({
              number: 208,
              mergeability: {
                mergeable: false,
                ciPassing: false,
                approved: false,
                noConflicts: true,
                blockers: ["API rate limited or unavailable"],
              },
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText(/GitHub API rate limited/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/GitHub API rate limited/i)).not.toBeInTheDocument();
  });

  it("opens the done bar and restores completed sessions", async () => {
    vi.setSystemTime(new Date("2026-04-11T11:07:00.000Z"));

    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "done-1",
            status: "terminated",
            activity: "exited",
            summaryIsFallback: true,
            issueTitle: "Restore completed agent",
            branch: null,
            lastActivityAt: "2026-04-11T09:07:00.000Z",
            pr: makePR({ number: 209, state: "merged", title: "Wrapped up work" }),
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Done \/ Terminated/i }));

    expect(screen.getByText("Restore completed agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#209" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/100",
    );
    expect(screen.getByText("merged")).toBeInTheDocument();
    expect(screen.getByText("2h ago")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/done-1/restore", {
      method: "POST",
    });
  });

  it("confirms termination from the mobile preview sheet", async () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-terminate",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need a kill confirmation path",
          }),
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /respond-terminate/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    });

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Terminate" }).at(-1)!);
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/respond-terminate/kill", {
      method: "POST",
    });
  });

  it("preserves feed cards across session updates", () => {
    const { rerender } = render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
          }),
        ]}
      />,
    );

    expect(screen.getByText("Need approval to proceed")).toBeInTheDocument();
    expect(screen.getByText("Implement dashboard filters")).toBeInTheDocument();

    rerender(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
            lastActivityAt: new Date(Date.now() + 1_000).toISOString(),
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
            lastActivityAt: new Date(Date.now() + 2_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(screen.getByText("Need approval to proceed")).toBeInTheDocument();
    expect(screen.getByText("Implement dashboard filters")).toBeInTheDocument();
  });
});

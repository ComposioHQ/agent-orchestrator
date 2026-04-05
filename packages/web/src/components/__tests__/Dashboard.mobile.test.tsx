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

  it("caps mobile sections to five rows until view-all is tapped", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession({
        id: `needs-input-${index + 1}`,
        summary: `Need approval ${index + 1}`,
        status: "needs_input",
        activity: "waiting_input",
      }),
    );

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.getByText("Need approval 1")).toBeInTheDocument();
    expect(screen.getByText("Need approval 5")).toBeInTheDocument();
    expect(screen.queryByText("Need approval 6")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /view all 6/i }));

    expect(screen.getByText("Need approval 6")).toBeInTheDocument();
  });

  it("opens a preview sheet from a mobile row and keeps prompting out of the dashboard", async () => {
    const session = makeSession({
      id: "respond-1",
      status: "needs_input",
      activity: "waiting_input",
      summary: "Need approval to proceed",
      branch: "feat/mobile-density",
      issueLabel: "#557",
    });

    render(<Dashboard initialSessions={[session]} />);

    expect(screen.getByRole("link", { name: /go to need approval to proceed/i })).toHaveAttribute(
      "href",
      "/sessions/respond-1",
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open need approval to proceed/i }));
    });

    expect(screen.getByRole("link", { name: "Open session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminate" })).toBeInTheDocument();
    expect(screen.getAllByText("Need approval to proceed").length).toBeGreaterThan(1);
    expect(screen.getAllByText("respond").length).toBeGreaterThan(0);
    expect(screen.getAllByText("needs input").length).toBeGreaterThan(0);
    expect(screen.getByText("waiting input")).toBeInTheDocument();
    expect(screen.getByText("feat/mobile-density")).toBeInTheDocument();
    expect(screen.getByText("#557")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Type a reply...")).not.toBeInTheDocument();
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
      fireEvent.click(screen.getByRole("button", { name: /open need approval to proceed/i }));
    });

    expect(screen.getByRole("button", { name: "Terminate" })).toBeInTheDocument();
    expect(screen.getAllByText("needs input").length).toBeGreaterThan(0);

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
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Working" }));

    expect(screen.getByText("Implement dashboard filters")).toBeInTheDocument();
    expect(screen.queryByText("Need approval to proceed")).not.toBeInTheDocument();
  });

  it("shows a stable empty state when an expanded mobile section has no sessions", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ready" }));

    expect(screen.getByText("Nothing cleared to land yet.")).toBeInTheDocument();
  });

  it("preserves a deliberate all-collapsed state across session updates", () => {
    const { rerender } = render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
          }),
        ]}
      />,
    );

    const respondAccordion = screen.getByRole("button", { name: /respond 1/i });
    expect(respondAccordion).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(respondAccordion);
    expect(respondAccordion).toHaveAttribute("aria-expanded", "false");

    rerender(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            lastActivityAt: new Date(Date.now() + 1_000).toISOString(),
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            lastActivityAt: new Date(Date.now() + 2_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /respond 1/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: /working 1/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

const eventSourceConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  const eventSourceMock = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
  eventSourceConstructorMock.mockReset();
  eventSourceConstructorMock.mockImplementation(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructorMock, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn();
});

describe("Dashboard empty state", () => {
  it("shows empty state when there are no sessions (single-project view)", () => {
    render(<Dashboard initialSessions={[]} />);
    expect(screen.getByText(/Ready to orchestrate/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Open the main orchestrator to start a session and fan out parallel agents across your codebase/i),
    ).toBeInTheDocument();
  });

  it("does not show empty state when sessions exist", () => {
    const { queryByText } = render(
      <Dashboard
        initialSessions={[
          {
            id: "s1",
            projectId: "proj",
            status: "working",
            activity: "active",
            branch: "feat/x",
            issueId: null,
            issueUrl: null,
            issueLabel: null,
            issueTitle: null,
            summary: "Working on it",
            summaryIsFallback: false,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            pr: null,
            metadata: {},
          },
        ]}
      />,
    );
    expect(queryByText(/Ready to orchestrate/i)).not.toBeInTheDocument();
  });

  it("shows load error banner instead of empty state when SSR services failed", () => {
    render(
      <Dashboard
        initialSessions={[]}
        dashboardLoadError="No agent-orchestrator.yaml found"
      />,
    );
    expect(screen.queryByText(/Ready to orchestrate/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Orchestrator failed to load");
    expect(screen.getByRole("alert")).toHaveTextContent("No agent-orchestrator.yaml found");
    expect(eventSourceConstructorMock).toHaveBeenCalledTimes(1);
  });

  it("shows empty state when only done sessions exist", () => {
    render(
      <Dashboard
        initialSessions={[
          {
            id: "s-done",
            projectId: "proj",
            status: "killed",
            activity: "exited",
            branch: "feat/done",
            issueId: null,
            issueUrl: null,
            issueLabel: null,
            issueTitle: null,
            summary: "Finished",
            summaryIsFallback: false,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            pr: null,
            metadata: {},
          },
        ]}
      />,
    );

    expect(screen.getByText(/Ready to orchestrate/i)).toBeInTheDocument();
    expect(screen.getByText("Done / Terminated")).toBeInTheDocument();
  });
});

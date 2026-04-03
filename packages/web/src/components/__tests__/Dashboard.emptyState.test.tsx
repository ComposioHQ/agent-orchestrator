import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

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
  const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructor, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn();
});

describe("Dashboard empty state", () => {
  it("shows empty state when there are no sessions (single-project view)", () => {
    render(<Dashboard initialSessions={[]} />);
    expect(screen.getByText(/No active worker sessions right now/i)).toBeInTheDocument();
    expect(screen.getByText(/main orchestrator button in the header/i)).toBeInTheDocument();
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
    expect(queryByText(/No active worker sessions right now/i)).not.toBeInTheDocument();
  });

  it("shows empty state when all sessions are done", () => {
    render(
      <Dashboard
        initialSessions={[
          {
            id: "s1",
            projectId: "proj",
            status: "merged",
            activity: "exited",
            branch: "feat/x",
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

    expect(screen.getByText(/No active worker sessions right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Attention Board/i)).not.toBeInTheDocument();
  });

  it("shows empty state when only an orchestrator exists", () => {
    render(
      <Dashboard
        initialSessions={[]}
        projectId="proj"
        orchestrators={[{ id: "proj-orchestrator", projectId: "proj", projectName: "Proj" }]}
      />,
    );

    expect(screen.getByText(/No active worker sessions right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Attention Board/i)).not.toBeInTheDocument();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import type { GlobalPauseState } from "@/lib/types";
import { makeSession } from "@/__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("Dashboard globalPause banner", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };

  const defaultStats = {
    totalSessions: 1,
    workingSessions: 1,
    openPRs: 0,
    needsReview: 0,
  };

  const makeGlobalPause = (overrides: Partial<GlobalPauseState> = {}): GlobalPauseState => ({
    pausedUntil: new Date(Date.now() + 3600000).toISOString(),
    reason: "Model rate limit reached",
    sourceSessionId: "session-1",
    ...overrides,
  });

  beforeEach(() => {
    eventSourceMock = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
    };
    global.EventSource = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows banner when initialGlobalPause is set", () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause();

    render(
      <Dashboard
        initialSessions={sessions}
        stats={defaultStats}
        initialGlobalPause={globalPause}
      />,
    );

    expect(screen.getByText(/Orchestrator paused:/)).toBeInTheDocument();
    expect(screen.getByText(/Model rate limit reached/)).toBeInTheDocument();
  });

  it("hides banner when initialGlobalPause is null", () => {
    const sessions = [makeSession()];

    render(<Dashboard initialSessions={sessions} stats={defaultStats} initialGlobalPause={null} />);

    expect(screen.queryByText(/Orchestrator paused:/)).not.toBeInTheDocument();
  });

  it("shows banner with custom reason from any provider", () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause({ reason: "Custom provider limit exceeded" });

    render(
      <Dashboard
        initialSessions={sessions}
        stats={defaultStats}
        initialGlobalPause={globalPause}
      />,
    );

    expect(screen.getByText(/Custom provider limit exceeded/)).toBeInTheDocument();
  });

  it("displays source session ID when provided", () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause({ sourceSessionId: "my-worker-42" });

    render(
      <Dashboard
        initialSessions={sessions}
        stats={defaultStats}
        initialGlobalPause={globalPause}
      />,
    );

    expect(screen.getByText(/Source: my-worker-42/)).toBeInTheDocument();
  });

  it("banner appears from state update via SSE (provider-agnostic)", async () => {
    const sessions = [makeSession()];

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [...sessions, makeSession({ id: "session-new" })],
        globalPause: makeGlobalPause({ reason: "Rate limit from any agent" }),
      }),
    } as Response);

    render(<Dashboard initialSessions={sessions} stats={defaultStats} initialGlobalPause={null} />);

    expect(screen.queryByText(/Orchestrator paused:/)).not.toBeInTheDocument();

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

    await act(async () => {
      eventSourceMock.onmessage!({
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            {
              id: "session-0",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: "session-new",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(screen.getByText(/Orchestrator paused:/)).toBeInTheDocument();
      expect(screen.getByText(/Rate limit from any agent/)).toBeInTheDocument();
    });
  });

  it("banner disappears from state update via SSE (pause expires)", async () => {
    const sessions = [makeSession()];
    const globalPause = makeGlobalPause();

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sessions: [...sessions, makeSession({ id: "session-new" })],
        globalPause: null,
      }),
    } as Response);

    render(
      <Dashboard
        initialSessions={sessions}
        stats={defaultStats}
        initialGlobalPause={globalPause}
      />,
    );

    expect(screen.getByText(/Orchestrator paused:/)).toBeInTheDocument();

    await waitFor(() => expect(eventSourceMock.onmessage).not.toBeNull());

    await act(async () => {
      eventSourceMock.onmessage!({
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            {
              id: "session-0",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
            {
              id: "session-new",
              status: "working",
              activity: "active",
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(screen.queryByText(/Orchestrator paused:/)).not.toBeInTheDocument();
    });
  });
});

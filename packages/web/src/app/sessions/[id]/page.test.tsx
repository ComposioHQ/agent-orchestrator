import React, { type ReactNode } from "react";
import { act, render, screen, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@/lib/types";
import type { SessionPatch } from "@/lib/mux-protocol";

const sessionDetailSpy = vi.fn();
const notFoundError = new Error("NEXT_NOT_FOUND");
const notFoundSpy = vi.fn(() => {
  throw notFoundError;
});
const mockMuxState: {
  current?: { sessions: SessionPatch[]; status?: "connecting" | "connected" | "reconnecting" | "disconnected" };
} = {};

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "worker-1" }),
  notFound: notFoundSpy,
}));

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => mockMuxState.current,
}));

vi.mock("@/components/SessionDetail", () => ({
  SessionDetail: (props: unknown) => {
    sessionDetailSpy(props);
    return <div data-testid="session-detail" />;
  },
}));

function makeWorkerSession(): DashboardSession {
  return {
    id: "worker-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: "https://linear.app/test/issue/INT-100",
    issueUrl: "https://linear.app/test/issue/INT-100",
    issueLabel: "INT-100",
    summary: "Test worker session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    agentReportAudit: [],
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

class TestErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <div data-testid="route-error">{this.state.error.message}</div>;
    }
    return this.props.children;
  }
}

describe("SessionPage project polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sessionDetailSpy.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockMuxState.current = undefined;

    const eventSourceMock = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    global.EventSource = vi.fn(
      () => eventSourceMock as unknown as EventSource,
    ) as unknown as typeof EventSource;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    notFoundSpy.mockReset();
  });

  it("resolves orchestrator nav once for non-orchestrator pages and skips repeated project polling", async () => {
    const workerSession = makeWorkerSession();
    const sidebarSessions = [workerSession];

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: sidebarSessions }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            orchestratorId: "my-app-orchestrator",
            orchestrators: [
              {
                id: "my-app-orchestrator",
                projectId: "my-app",
                projectName: "My App",
              },
            ],
          }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    expect(fetch).toHaveBeenCalledWith("/api/projects");
    expect(fetch).toHaveBeenCalledWith("/api/sessions/worker-1");
    expect(fetch).toHaveBeenCalledWith("/api/sessions");

    expect(fetch).toHaveBeenCalledWith("/api/sessions?project=my-app&orchestratorOnly=true");

    expect(
      vi.mocked(fetch).mock.calls.filter(
        ([url]) => url === "/api/sessions?project=my-app&orchestratorOnly=true",
      ),
    ).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await flushAsyncWork();

    expect(
      vi.mocked(fetch).mock.calls.filter(
        ([url]) => url === "/api/sessions?project=my-app&orchestratorOnly=true",
      ),
    ).toHaveLength(1);

    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/sessions"),
    ).toHaveLength(2);
  });

  it("routes 404 responses through notFound()", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    expect(notFoundSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("session-detail")).not.toBeInTheDocument();
  });

  it("throws non-404 session fetch failures to the route error boundary", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ projects: [] }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(
      <TestErrorBoundary>
        <SessionPage />
      </TestErrorBoundary>,
    );

    await flushAsyncWork();

    expect(screen.getByTestId("route-error")).toHaveTextContent("HTTP 500");
  });

  it("marks sidebar data as loading until the sessions list resolves", async () => {
    const workerSession = makeWorkerSession();
    let resolveSidebarSessions: ((value: Response) => void) | null = null;

    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response);
      }

      if (url === "/api/sessions") {
        return new Promise<Response>((resolve) => {
          resolveSidebarSessions = resolve;
        });
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    const latestBeforeSidebarResolve = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestBeforeSidebarResolve.sidebarLoading).toBe(true);
    expect(latestBeforeSidebarResolve.sidebarSessions).toBeNull();

    await act(async () => {
      resolveSidebarSessions?.({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [workerSession] }),
      } as Response);
      await Promise.resolve();
    });

    const latestAfterSidebarResolve = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestAfterSidebarResolve.sidebarLoading).toBe(false);
    expect(latestAfterSidebarResolve.sidebarSessions).toEqual([workerSession]);
  });

  it("revalidates projects and sidebar sessions on remount even when cache exists", async () => {
    const workerSession = makeWorkerSession();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessions: [workerSession] }),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;

    const { default: SessionPage } = await import("./page");

    const firstRender = render(<SessionPage />);
    await flushAsyncWork();
    firstRender.unmount();

    render(<SessionPage />);
    await flushAsyncWork();

    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/projects"),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(([url]) => url === "/api/sessions"),
    ).toHaveLength(2);
  });

  it("surfaces sidebar fetch failures instead of leaving the loading skeleton active", async () => {
    const workerSession = makeWorkerSession();

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response;
      }

      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response;
      }

      if (url === "/api/sessions") {
        return {
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response;
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response;
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    const latestProps = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarError?: boolean;
      sidebarLoading?: boolean;
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestProps.sidebarLoading).toBe(false);
    expect(latestProps.sidebarError).toBe(true);
    expect(latestProps.sidebarSessions).toEqual([]);
  });

  it("applies mux snapshots that arrive before the initial sidebar fetch resolves", async () => {
    const workerSession = makeWorkerSession();
    const muxPatchedLastActivityAt = "2026-04-14T12:00:00.000Z";
    let resolveSidebarSessions: ((value: Response) => void) | null = null;

    mockMuxState.current = {
      status: "connected",
      sessions: [
        {
          id: "worker-1",
          status: "working",
          activity: "ready",
          attentionLevel: "pending",
          lastActivityAt: muxPatchedLastActivityAt,
        },
      ],
    };

    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            projects: [{ id: "my-app", name: "My App", sessionPrefix: "my-app" }],
          }),
        } as Response);
      }

      if (url === "/api/sessions/worker-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => workerSession,
        } as Response);
      }

      if (url === "/api/sessions") {
        return new Promise<Response>((resolve) => {
          resolveSidebarSessions = resolve;
        });
      }

      if (url === "/api/sessions?project=my-app&orchestratorOnly=true") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ orchestratorId: "my-app-orchestrator" }),
        } as Response);
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    }) as typeof fetch;

    const { default: SessionPage } = await import("./page");

    render(<SessionPage />);
    await flushAsyncWork();

    await act(async () => {
      resolveSidebarSessions?.({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [workerSession] }),
      } as Response);
      await Promise.resolve();
    });

    const latestProps = sessionDetailSpy.mock.lastCall?.[0] as {
      sidebarSessions?: DashboardSession[] | null;
    };

    expect(latestProps.sidebarSessions).toEqual([
      {
        ...workerSession,
        activity: "ready",
        lastActivityAt: muxPatchedLastActivityAt,
      },
    ]);
  });
});

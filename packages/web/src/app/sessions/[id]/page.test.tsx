import { act, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@/lib/types";

const sessionDetailSpy = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "worker-1" }),
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
  };
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("SessionPage project polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionDetailSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves orchestrator nav once for non-orchestrator pages and skips repeated project polling", async () => {
    const workerSession = makeWorkerSession();

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/sessions/worker-1") {
        return {
          ok: true,
          status: 200,
          json: async () => workerSession,
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

    expect(fetch).toHaveBeenCalledWith("/api/sessions/worker-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushAsyncWork();

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
  });
});

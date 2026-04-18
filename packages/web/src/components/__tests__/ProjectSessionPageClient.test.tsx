import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSession } from "@/__tests__/helpers";

const sessionDetailMock = vi.fn<
  (props: {
    projectOrchestratorId?: string | null;
    isOrchestrator?: boolean;
    session: { id: string };
  }) => JSX.Element
>();

vi.mock("../SessionDetail", () => ({
  SessionDetail: (props: {
    projectOrchestratorId?: string | null;
    isOrchestrator?: boolean;
    session: { id: string };
  }) => sessionDetailMock(props),
}));

describe("ProjectSessionPageClient", () => {
  beforeEach(() => {
    sessionDetailMock.mockImplementation(({ projectOrchestratorId, session }) => (
      <div>
        <span>{session.id}</span>
        <span>{projectOrchestratorId ?? "none"}</span>
      </div>
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the project orchestrator id for worker session pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeSession({ id: "worker-1", projectId: "my-app" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          orchestratorId: "my-app-orchestrator",
          orchestrators: [{ id: "my-app-orchestrator" }],
          sessions: [],
        }),
      });

    global.fetch = fetchMock as typeof fetch;

    const { ProjectSessionPageClient } = await import("../ProjectSessionPageClient");

    render(<ProjectSessionPageClient projectId="my-app" sessionId="worker-1" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions/worker-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/sessions?project=my-app&orchestratorOnly=true",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(screen.getByText("my-app-orchestrator")).toBeInTheDocument();
    }, { timeout: 4_000 });
  }, 10_000);
});

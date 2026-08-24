import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSession, WorkspaceSummary } from "../types/workspace";
import { useUiStore } from "../stores/ui-store";

const { navigateMock, restartMock, spawnMock, workspaceQueryMock } = vi.hoisted(
  () => ({
    navigateMock: vi.fn(),
    restartMock: vi.fn(),
    spawnMock: vi.fn(),
    workspaceQueryMock: vi.fn(),
  }),
);

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    createFileRoute: () => (options: object) => ({
      options,
      useParams: () => ({ projectId: "proj-1" }),
    }),
    useNavigate: () => navigateMock,
  };
});

vi.mock("../hooks/useWorkspaceQuery", () => ({
  useWorkspaceQuery: () => workspaceQueryMock(),
  workspaceQueryKey: ["workspaces"],
}));

vi.mock("../components/SessionView", () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="session-view">session {sessionId}</div>
  ),
}));

vi.mock("../lib/restart-orchestrator", () => ({
  restartProjectOrchestrator: restartMock,
}));

vi.mock("../lib/spawn-orchestrator", () => ({
  spawnOrchestrator: spawnMock,
  isChatPreflightError: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error,
  chatPreflightGuidance: (code?: string) =>
    code === "CHAT_AUTH_REQUIRED"
      ? "The configured orchestrator agent must be signed in before it can start a Chat session."
      : undefined,
}));

import { ProjectOrchestratorRoute } from "./_shell.projects.$projectId_.orchestrator";

const worker: WorkspaceSession = {
  id: "worker-1",
  workspaceId: "proj-1",
  workspaceName: "Project One",
  title: "Ship the route",
  provider: "codex",
  kind: "worker",
  status: "working",
  updatedAt: "2026-08-20T00:00:00Z",
  prs: [],
};

const orchestrator: WorkspaceSession = {
  ...worker,
  id: "orch-1",
  title: "Project orchestrator",
  kind: "orchestrator",
  activity: { state: "active", lastActivityAt: "2026-08-20T00:00:00Z" },
};

function workspace(
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id: "proj-1",
    name: "Project One",
    path: "/repo/project-one",
    orchestratorAgent: "codex",
    sessions: [],
    ...overrides,
  };
}

function renderRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <ProjectOrchestratorRoute />
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

beforeEach(() => {
  navigateMock.mockReset();
  restartMock.mockReset().mockResolvedValue(undefined);
  spawnMock.mockReset().mockResolvedValue("orch-new");
  workspaceQueryMock.mockReset().mockReturnValue({
    data: [workspace()],
    isLoading: false,
  });
  useUiStore.setState({
    orchestratorReplacementErrors: {},
    orchestratorStartupErrors: {},
    restartingProjectIds: new Set(),
    settingsModal: null,
  });
});

describe("ProjectOrchestratorRoute", () => {
  it("is a stable missing destination and starts with the non-destructive ensure", async () => {
    renderRoute();

    expect(screen.getByTestId("orchestrator-route")).toHaveAttribute(
      "data-orchestrator-state",
      "missing",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Start orchestrator" }),
    );

    await waitFor(() =>
      expect(spawnMock).toHaveBeenCalledWith(
        "proj-1",
        "orchestrator_route",
        false,
        "chat",
      ),
    );
  });

  it("links to settings instead of rendering a dead start button when no agent is configured", async () => {
    workspaceQueryMock.mockReturnValue({
      data: [workspace({ orchestratorAgent: undefined })],
      isLoading: false,
    });
    renderRoute();

    expect(
      screen.queryByRole("button", { name: "Start orchestrator" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Choose an orchestrator agent first"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Project settings" }),
    );

    expect(useUiStore.getState().settingsModal).toEqual({
      scope: "project",
      projectId: "proj-1",
    });
  });

  it("renders the running session and links every project worker", async () => {
    workspaceQueryMock.mockReturnValue({
      data: [workspace({ sessions: [orchestrator, worker] })],
      isLoading: false,
    });
    renderRoute();

    expect(screen.getByTestId("orchestrator-route")).toHaveAttribute(
      "data-orchestrator-state",
      "running",
    );
    expect(screen.getByTestId("session-view")).toHaveTextContent("orch-1");
    await userEvent.click(
      screen.getByRole("button", { name: /Ship the route/ }),
    );
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$projectId/sessions/$sessionId",
      params: { projectId: "proj-1", sessionId: "worker-1" },
    });
  });

  it("requires confirmation before the destructive clean restart", async () => {
    workspaceQueryMock.mockReturnValue({
      data: [workspace({ sessions: [orchestrator] })],
      isLoading: false,
    });
    renderRoute();

    await userEvent.click(
      screen.getByRole("button", { name: "Restart orchestrator" }),
    );
    expect(restartMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", {
      name: "Restart project orchestrator?",
    });
    expect(dialog).toHaveTextContent("retires every live orchestrator");

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Restart orchestrator" }),
    );
    expect(restartMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1" }),
    );
  });

  it("explains Chat preflight failures and keeps settings reachable", async () => {
    spawnMock.mockRejectedValue({ code: "CHAT_AUTH_REQUIRED" });
    renderRoute();

    await userEvent.click(
      screen.getByRole("button", { name: "Start orchestrator" }),
    );
    expect(
      await screen.findByText(
        /must be signed in before it can start a Chat session/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Project settings" }),
    ).toBeEnabled();
  });
});

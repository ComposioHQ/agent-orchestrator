import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OrchestratorSelector } from "@/components/OrchestratorSelector";
import OrchestratorsRoute from "@/app/orchestrators/page";
import { getServices } from "@/lib/services";
import { getAllProjects } from "@/lib/project-name";

// ── Mocks ─────────────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: vi.fn(),
}));

global.fetch = vi.fn();

// ── Tests ─────────────────────────────────────────────────────────────

describe("OrchestratorSelector Component", () => {
  const defaultProps = {
    orchestrators: [
      {
        id: "orch-1",
        projectId: "my-app",
        projectName: "My App",
        status: "working",
        activity: "active",
        createdAt: new Date(Date.now() - 3600000 * 2).toISOString(), // 2h ago
        lastActivityAt: new Date(Date.now() - 60000 * 5).toISOString(), // 5m ago
      },
    ],
    projectId: "my-app",
    projectName: "My App",
    projects: [{ id: "my-app", name: "My App" }],
    error: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders orchestrators and handles spawn success", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ orchestrator: { id: "new-orch" } }),
    });

    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByText("orch-1")).toBeInTheDocument();
    expect(screen.getByText(/2h ago/)).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();

    const spawnBtn = screen.getByText("Start New Orchestrator");
    fireEvent.click(spawnBtn);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/sessions/new-orch");
    });
  });

  it("covers relative time for days and status colors/labels", () => {
    const wideProps = {
      ...defaultProps,
      orchestrators: [
        {
          id: "orch-2",
          projectId: "my-app",
          projectName: "My App",
          status: "ci_failed",
          activity: "waiting_input",
          createdAt: new Date(Date.now() - 3600000 * 50).toISOString(), // 2d ago
          lastActivityAt: null,
        },
        {
          id: "orch-3",
          projectId: "my-app",
          projectName: "My App",
          status: "killed",
          activity: "ready",
          createdAt: new Date(Date.now() - 1000).toISOString(), // Just now
          lastActivityAt: null,
        },
        {
           id: "orch-4",
           projectId: "my-app",
           projectName: "My App",
           status: "unknown",
           activity: "blocked",
           createdAt: new Date().toISOString(),
           lastActivityAt: null,
        },
        {
           id: "orch-5",
           projectId: "my-app",
           projectName: "My App",
           status: "mergeable",
           activity: "exited",
           createdAt: new Date().toISOString(),
           lastActivityAt: null,
        }
      ],
    };

    render(<OrchestratorSelector {...wideProps} />);
    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
    expect(screen.getAllByText(/Just now/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Waiting/)).toBeInTheDocument();
    expect(screen.getByText(/Ready/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText(/Exited/)).toBeInTheDocument();
    expect(screen.getByText(/ci failed/i)).toBeInTheDocument();
  });

  it("handles spawn failure with error message", async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Server error" }),
    });

    render(<OrchestratorSelector {...defaultProps} orchestrators={[]} />);
    fireEvent.click(screen.getByText("Start New Orchestrator"));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("renders error state from props", () => {
    render(<OrchestratorSelector {...defaultProps} error="Project not found" />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.getByText("Go to Dashboard")).toHaveAttribute("href", "/");
  });
});

describe("Orchestrators Page (OrchestratorsRoute)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page with searchParams and listed orchestrators", async () => {
    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([
        {
          id: "app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
          createdAt: new Date(),
          lastActivityAt: new Date(),
        },
      ]),
    };

    (getServices as any).mockResolvedValue({
      config: {
        projects: {
          "my-app": { name: "My App", sessionPrefix: "app" },
        },
      },
      sessionManager: mockSessionManager,
    });

    (getAllProjects as any).mockReturnValue([{ id: "my-app", name: "My App" }]);

    const searchParams = Promise.resolve({ project: "my-app" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText("app-orchestrator")).toBeInTheDocument();
  });

  it("shows error when project is missing in searchParams", async () => {
    const searchParams = Promise.resolve({});
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("Missing Project")).toBeInTheDocument();
  });

  it("shows error when project is not found in config", async () => {
    (getServices as any).mockResolvedValue({
      config: { projects: {} },
      sessionManager: { list: vi.fn() },
    });
    (getAllProjects as any).mockReturnValue([]);

    const searchParams = Promise.resolve({ project: "ghost" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText('Project "ghost" not found')).toBeInTheDocument();
  });

  it("handles service errors gracefully", async () => {
    (getServices as any).mockRejectedValue(new Error("Database down"));

    const searchParams = Promise.resolve({ project: "my-app" });
    const jsx = await OrchestratorsRoute({ searchParams });
    render(jsx);

    expect(screen.getByText("Database down")).toBeInTheDocument();
  });
});

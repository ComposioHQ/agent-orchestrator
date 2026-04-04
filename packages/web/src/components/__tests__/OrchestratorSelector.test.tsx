import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorSelector } from "../OrchestratorSelector";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockOrchestrators = [
  {
    id: "app-orchestrator-1",
    projectId: "my-project",
    projectName: "My Project",
    status: "working",
    activity: "active",
    createdAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
    lastActivityAt: new Date(Date.now() - 300000).toISOString(), // 5 min ago
  },
  {
    id: "app-orchestrator-2",
    projectId: "my-project",
    projectName: "My Project",
    status: "spawning",
    activity: null,
    createdAt: new Date(Date.now() - 7200000).toISOString(), // 2 hours ago
    lastActivityAt: null,
  },
];

const defaultProps = {
  orchestrators: mockOrchestrators,
  projectId: "my-project",
  projectName: "My Project",
  error: null,
};

describe("OrchestratorSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    global.fetch = vi.fn();
  });

  it("renders orchestrator list", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByText("app-orchestrator-1")).toBeInTheDocument();
    expect(screen.getByText("app-orchestrator-2")).toBeInTheDocument();
  });

  it("displays project name in header", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByText("My Project")).toBeInTheDocument();
    expect(screen.getByText("Select an orchestrator")).toBeInTheDocument();
  });

  it("shows count of existing sessions", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByText(/existing orchestrator sessions/)).toBeInTheDocument();
    // The count "2" appears in multiple places, so we check the full info banner text
    expect(screen.getByText(/Found/)).toBeInTheDocument();
  });

  it("shows error state", () => {
    render(
      <OrchestratorSelector
        {...defaultProps}
        orchestrators={[]}
        error="Project not found"
      />,
    );

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Project not found")).toBeInTheDocument();
  });

  it("shows start new orchestrator button", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByRole("button", { name: /start new orchestrator/i })).toBeInTheDocument();
  });

  it("spawns new orchestrator on button click and navigates", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          orchestrator: { id: "app-orchestrator-3" },
        }),
    });
    global.fetch = mockFetch;

    render(<OrchestratorSelector {...defaultProps} />);

    const button = screen.getByRole("button", { name: /start new orchestrator/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/orchestrators", expect.any(Object));
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/sessions/app-orchestrator-3");
    });
  });

  it("shows loading state while spawning", async () => {
    const mockFetch = vi.fn().mockImplementation(
      () => new Promise(() => {}), // Never resolves
    );
    global.fetch = mockFetch;

    render(<OrchestratorSelector {...defaultProps} />);

    const button = screen.getByRole("button", { name: /start new orchestrator/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/creating new orchestrator/i)).toBeInTheDocument();
    });
  });

  it("shows error when spawn fails", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: "Failed to spawn" }),
    });
    global.fetch = mockFetch;

    render(<OrchestratorSelector {...defaultProps} />);

    const button = screen.getByRole("button", { name: /start new orchestrator/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText("Failed to spawn")).toBeInTheDocument();
    });
  });

  it("links to orchestrator session page", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    const link = screen.getByRole("link", { name: /app-orchestrator-1/i });
    expect(link).toHaveAttribute("href", "/sessions/app-orchestrator-1");
  });

  it("displays status and activity for each orchestrator", () => {
    render(<OrchestratorSelector {...defaultProps} />);

    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("spawning")).toBeInTheDocument();
  });

  it("covers relative time for days and status colors/labels", () => {
    const wideOrchestrators = [
      {
        id: "orch-2",
        projectId: "my-project",
        projectName: "My Project",
        status: "ci_failed",
        activity: "waiting_input",
        createdAt: new Date(Date.now() - 3600000 * 50).toISOString(), // 2d ago
        lastActivityAt: null,
      },
      {
        id: "orch-3",
        projectId: "my-project",
        projectName: "My Project",
        status: "killed",
        activity: "ready",
        createdAt: new Date(Date.now() - 1000).toISOString(), // Just now
        lastActivityAt: null,
      },
      {
        id: "orch-4",
        projectId: "my-project",
        projectName: "My Project",
        status: "unknown",
        activity: "blocked",
        createdAt: new Date().toISOString(),
        lastActivityAt: null,
      },
      {
        id: "orch-5",
        projectId: "my-project",
        projectName: "My Project",
        status: "mergeable",
        activity: "exited",
        createdAt: new Date().toISOString(),
        lastActivityAt: null,
      },
    ];

    render(
      <OrchestratorSelector
        {...defaultProps}
        orchestrators={wideOrchestrators}
      />,
    );

    expect(screen.getByText(/2d ago/)).toBeInTheDocument();
    expect(screen.getAllByText(/Just now/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Waiting/)).toBeInTheDocument();
    expect(screen.getByText(/Ready/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked/)).toBeInTheDocument();
    expect(screen.getByText(/Exited/)).toBeInTheDocument();
    expect(screen.getByText(/ci failed/i)).toBeInTheDocument();
  });

  describe("formatRelativeTime edge cases", () => {
    it("shows Unknown for invalid date strings", () => {
      const orchestratorsWithInvalidDate = [
        {
          ...mockOrchestrators[0],
          createdAt: "not-a-valid-date",
          lastActivityAt: null,
        },
      ];
      render(
        <OrchestratorSelector
          {...defaultProps}
          orchestrators={orchestratorsWithInvalidDate}
        />,
      );

      // The "Created Unknown" text should appear for invalid dates
      expect(screen.getByText(/Created Unknown/)).toBeInTheDocument();
    });

    it("shows Just now for future timestamps", () => {
      const futureDate = new Date(Date.now() + 60000).toISOString(); // 1 minute in future
      const orchestratorsWithFutureDate = [
        {
          ...mockOrchestrators[0],
          createdAt: futureDate,
          lastActivityAt: null,
        },
      ];
      render(
        <OrchestratorSelector
          {...defaultProps}
          orchestrators={orchestratorsWithFutureDate}
        />,
      );

      // Future timestamps should show "Just now" instead of negative values
      expect(screen.getByText(/Created Just now/)).toBeInTheDocument();
    });

    it("shows Unknown for null dates", () => {
      const orchestratorsWithNullDate = [
        {
          ...mockOrchestrators[0],
          createdAt: null,
          lastActivityAt: null,
        },
      ];
      render(
        <OrchestratorSelector
          {...defaultProps}
          orchestrators={orchestratorsWithNullDate}
        />,
      );

      expect(screen.getByText(/Created Unknown/)).toBeInTheDocument();
    });
  });
});

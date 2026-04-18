import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { makeSession } from "@/__tests__/helpers";

const mockPush = vi.fn();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}));

describe("ProjectSidebar", () => {
  const projects = [
    { id: "project-1", name: "Project One", sessionPrefix: "project-1" },
    { id: "project-2", name: "Project Two", sessionPrefix: "project-2" },
  ];

  beforeEach(() => {
    mockPush.mockReset();
    mockPathname = "/";
    global.fetch = vi.fn();
    window.fetch = global.fetch;
    window.localStorage.clear();
  });

  it("renders nothing when there are no projects", () => {
    const { container } = render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it("renders the compact sidebar header and project rows", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Project One/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open Project Two/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
  });

  it("marks the active project row as the current page", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /Open Project Two/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /Open Project One/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("navigates to the canonical project page when clicking a project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open Project Two/ }));

    expect(mockPush).toHaveBeenCalledWith("/projects/project-2");
  });

  it("navigates to the canonical project page from session pages", () => {
    mockPathname = "/sessions/ao-143";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open Project Two/ }));

    expect(mockPush).toHaveBeenCalledWith("/projects/project-2");
  });

  it("does not re-navigate when clicking the active project page row", () => {
    mockPathname = "/projects/project-1";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Keep sidebar stable",
            branch: null,
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Open Project One/ }));

    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Open Keep sidebar stable" })).toBeInTheDocument();
  });

  it("shows non-done worker sessions for the expanded active project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
          makeSession({
            id: "worker-2",
            projectId: "project-1",
            summary: "Already done",
            status: "merged",
            activity: "exited",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-1"
      />,
    );

    expect(screen.getByRole("link", { name: "Open Review API changes" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open feat/test" })).not.toBeInTheDocument();
  });

  it("only toggles project expansion from the chevron control", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-2",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.queryByRole("link", { name: "Open Review API changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand Project Two sessions/ }));
    expect(screen.getByRole("link", { name: "Open Review API changes" })).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("navigates session rows to the selected session detail route", () => {
    mockPathname = "/sessions/ao-143";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
          makeSession({
            id: "worker-2",
            projectId: "project-1",
            summary: "Implement sidebar polish",
            branch: null,
            status: "working",
            activity: "active",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-1"
      />,
    );

    expect(screen.getByRole("link", { name: "Open Implement sidebar polish" })).toHaveAttribute(
      "href",
      "/projects/project-1/sessions/worker-2",
    );
  });

  it("does not re-navigate when clicking the active session row", () => {
    mockPathname = "/projects/project-1/sessions/worker-1";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-1"
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open Review API changes" }));

    expect(mockPush).not.toHaveBeenCalled();
  });

  it("filters out orchestrator sessions from the project tree", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "project-1-orchestrator",
            projectId: "project-1",
            summary: "Orchestrator",
          }),
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Implement sidebar polish",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("Orchestrator")).not.toBeInTheDocument();
  });

  it("renders the collapsed rail when collapsed", () => {
    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
      />,
    );

    expect(container.querySelector(".project-sidebar--collapsed")).not.toBeNull();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });

  it("shows loading skeletons instead of the empty state while sessions are loading", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={null}
        loading
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getAllByLabelText("Loading sessions").length).toBeGreaterThan(0);
    expect(screen.queryByText("No active sessions")).not.toBeInTheDocument();
  });

  it("does not render a per-project empty state when an expanded project has no active sessions", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.queryByText("No active sessions")).not.toBeInTheDocument();
  });

  it("calls onAddProject when the + button is clicked", () => {
    const onAddProject = vi.fn();
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        onAddProject={onAddProject}
      />,
    );
    fireEvent.click(screen.getByLabelText("New project"));
    expect(onAddProject).toHaveBeenCalledTimes(1);
  });

  it("shows available agents from the project-row + menu and spawns the selected one", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/agents") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            agents: [
              { id: "claude-code", name: "Claude Code" },
              { id: "codex", name: "Codex" },
            ],
          }),
        } as Response);
      }
      if (url === "/api/spawn") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            session: { id: "worker-123" },
          }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
    global.fetch = fetchMock as typeof fetch;
    window.fetch = fetchMock as typeof fetch;

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getAllByLabelText("Spawn agent")[0]);

    expect(await screen.findByRole("menu", { name: "Available agents for Project One" })).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/agents");
    });
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Codex/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/spawn",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: "project-1", agent: "codex" }),
        }),
      );
    });

    expect(mockPush).toHaveBeenCalledWith("/projects/project-1/sessions/worker-123");
  });
});

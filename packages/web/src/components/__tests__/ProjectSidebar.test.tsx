import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: /Project One/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Project Two/ })).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: /Project Two/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /Project One/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("navigates to the project query param when clicking a project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }));

    expect(mockPush).toHaveBeenCalledWith("/?project=project-2");
  });

  it("navigates to the dashboard root from session pages", () => {
    mockPathname = "/sessions/ao-143";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }));

    expect(mockPush).toHaveBeenCalledWith("/?project=project-2");
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

    expect(screen.getByRole("button", { name: "Open Review API changes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open feat/test" })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Open Implement sidebar polish" }));

    expect(mockPush).toHaveBeenCalledWith("/sessions/worker-2?project=project-1");
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
});

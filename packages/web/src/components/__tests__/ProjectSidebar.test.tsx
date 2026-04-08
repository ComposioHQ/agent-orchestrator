import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSidebar } from "@/components/ProjectSidebar";

const mockPush = vi.fn();
const mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname,
}));

describe("ProjectSidebar", () => {
  const projects = [
    { id: "project-1", name: "Project One" },
    { id: "project-2", name: "Project Two" },
    { id: "project-3", name: "Project Three" },
  ];

  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders nothing when there is only one project", () => {
    const { container } = render(
      <ProjectSidebar projects={[projects[0]]} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no projects", () => {
    const { container } = render(<ProjectSidebar projects={[]} sessions={[]} activeProjectId={undefined} activeSessionId={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders sidebar with all projects when there are multiple", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filter session list" })).toBeInTheDocument();
    expect(screen.getByText("All Projects")).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("Project Two")).toBeInTheDocument();
    expect(screen.getByText("Project Three")).toBeInTheDocument();
  });

  it("highlights active project", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-2" activeSessionId={undefined} />);
    const projectTwoButton = screen.getByRole("button", { name: "Project Two" });
    expect(projectTwoButton.className).toContain("accent");
  });

  it("highlights 'All Projects' when no project is active", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId={undefined} activeSessionId={undefined} />);
    const allProjectsButton = screen.getByRole("button", { name: "All Projects" });
    expect(allProjectsButton.className).toContain("accent");
  });

  it("expands project on header click without navigating (dashboard is a separate link)", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("exposes project dashboard link with correct href", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    const dash = screen.getByRole("link", { name: "Project Two dashboard" });
    expect(dash).toHaveAttribute("href", "/?project=project-2");
  });

  it("navigates to 'all' when clicking 'All Projects'", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "All Projects" }));
    expect(mockPush).toHaveBeenCalledWith("/?project=all");
  });

  it("encodes project ID in dashboard link href", () => {
    const projectsWithSpecialChars = [
      { id: "my-app", name: "My App" },
      { id: "other-project", name: "Other Project" },
    ];
    render(<ProjectSidebar projects={projectsWithSpecialChars} sessions={[]} activeProjectId="my-app" activeSessionId={undefined} />);
    const dash = screen.getByRole("link", { name: "Other Project dashboard" });
    expect(dash.getAttribute("href")).toContain("project=other-project");
  });

  it("counts only non-terminal worker sessions in Portfolio active metric", () => {
    const sessions = [
      {
        id: "s1",
        name: "active-session",
        projectId: "project-1",
        status: "working" as const,
        agentType: "claude-code" as const,
        prNumber: null,
        errorCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      {
        id: "s2",
        name: "spawning-session",
        projectId: "project-1",
        status: "spawning" as const,
        agentType: "claude-code" as const,
        prNumber: null,
        errorCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      {
        id: "s3",
        name: "done-session",
        projectId: "project-1",
        status: "done" as const,
        agentType: "claude-code" as const,
        prNumber: null,
        errorCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      {
        id: "s4",
        name: "killed-session",
        projectId: "project-1",
        status: "killed" as const,
        agentType: "claude-code" as const,
        prNumber: null,
        errorCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
      {
        id: "s5",
        name: "merged-session",
        projectId: "project-1",
        status: "merged" as const,
        agentType: "claude-code" as const,
        prNumber: null,
        errorCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    // Should show 2 active (working + spawning), excluding done, killed, merged
    const activeMetric = screen.getByText(/active/).closest("div");
    expect(activeMetric).toHaveTextContent("2");
  });
});

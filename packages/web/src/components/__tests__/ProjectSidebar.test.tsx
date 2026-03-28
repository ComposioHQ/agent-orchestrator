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

  it("navigates to project query param when clicking a project", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));
    expect(mockPush).toHaveBeenCalledWith("/?project=project-2");
  });

  it("navigates to 'all' when clicking 'All Projects'", () => {
    render(<ProjectSidebar projects={projects} sessions={[]} activeProjectId="project-1" activeSessionId={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "All Projects" }));
    expect(mockPush).toHaveBeenCalledWith("/?project=all");
  });

  it("encodes project ID in URL", () => {
    const projectsWithSpecialChars = [
      { id: "my-app", name: "My App" },
      { id: "other-project", name: "Other Project" },
    ];
    render(<ProjectSidebar projects={projectsWithSpecialChars} sessions={[]} activeProjectId="my-app" activeSessionId={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Other Project" }));
    expect(mockPush).toHaveBeenCalledWith("/?project=other-project");
  });
});

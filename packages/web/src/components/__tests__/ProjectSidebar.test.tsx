import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectSidebar } from "@/components/ProjectSidebar";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("ProjectSidebar", () => {
  const projects = [
    { id: "project-1", name: "Project One" },
    { id: "project-2", name: "Project Two" },
    { id: "project-3", name: "Project Three" },
  ];

  const defaultProps = {
    projects,
    activeProjectId: "project-1" as string | undefined,
    collapsed: false,
    onCollapsedChange: vi.fn(),
    width: 180,
    onWidthChange: vi.fn(),
  };

  beforeEach(() => {
    mockPush.mockClear();
    defaultProps.onCollapsedChange.mockClear();
    defaultProps.onWidthChange.mockClear();
  });

  it("renders sidebar even with only one project", () => {
    render(<ProjectSidebar {...defaultProps} projects={[projects[0]]} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
  });

  it("renders sidebar even with no projects", () => {
    render(<ProjectSidebar {...defaultProps} projects={[]} activeProjectId={undefined} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("All Projects")).toBeInTheDocument();
  });

  it("renders sidebar projects when there are multiple", () => {
    render(<ProjectSidebar {...defaultProps} />);
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Project One")).toBeInTheDocument();
    expect(screen.getByText("Project Two")).toBeInTheDocument();
    expect(screen.getByText("Project Three")).toBeInTheDocument();
  });

  it("highlights active project", () => {
    render(<ProjectSidebar {...defaultProps} activeProjectId="project-2" />);
    const projectTwoButton = screen.getByRole("button", { name: "Project Two" });
    expect(projectTwoButton.className).toContain("accent");
  });

  it("does not highlight project when no project is active", () => {
    render(<ProjectSidebar {...defaultProps} activeProjectId={undefined} />);
    const projectButtons = screen
      .getAllByRole("button")
      .filter(
        (b) =>
          b.textContent !== "All Projects" &&
          b.textContent !== "+ Add Project" &&
          b.getAttribute("aria-label") !== "Collapse sidebar",
      );
    projectButtons.forEach((button) => {
      expect(button.className).not.toContain("accent");
    });
  });

  it("navigates to project query param when clicking a project", () => {
    render(<ProjectSidebar {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));
    expect(mockPush).toHaveBeenCalledWith("/projects/project-2");
  });

  it("encodes project ID in URL", () => {
    const projectsWithSpecialChars = [
      { id: "my-app", name: "My App" },
      { id: "other-project", name: "Other Project" },
    ];
    render(<ProjectSidebar {...defaultProps} projects={projectsWithSpecialChars} activeProjectId="my-app" />);
    fireEvent.click(screen.getByRole("button", { name: "Other Project" }));
    expect(mockPush).toHaveBeenCalledWith("/projects/other-project");
  });

  it("renders All Projects button that navigates to /", () => {
    render(<ProjectSidebar {...defaultProps} />);
    const allProjectsButton = screen.getByRole("button", { name: "All Projects" });
    expect(allProjectsButton).toBeInTheDocument();
    fireEvent.click(allProjectsButton);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("highlights All Projects button when no project is active", () => {
    render(<ProjectSidebar {...defaultProps} activeProjectId={undefined} />);
    const allProjectsButton = screen.getByRole("button", { name: "All Projects" });
    expect(allProjectsButton.className).toContain("accent");
  });

  it("renders Add Project button that shows CLI hint on click", () => {
    render(<ProjectSidebar {...defaultProps} />);
    const addButton = screen.getByRole("button", { name: "+ Add Project" });
    expect(addButton).toBeInTheDocument();

    // Hint should not be visible initially
    expect(screen.queryByText(/ao init/)).toBeNull();

    // Click to show hint
    fireEvent.click(addButton);
    expect(screen.getByText(/ao init/)).toBeInTheDocument();

    // Click again to hide hint
    fireEvent.click(addButton);
    expect(screen.queryByText(/ao init/)).toBeNull();
  });

  // --- Collapse/Expand tests ---

  it("renders collapse button when expanded", () => {
    render(<ProjectSidebar {...defaultProps} />);
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("calls onCollapsedChange(true) when collapse button is clicked", () => {
    render(<ProjectSidebar {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(defaultProps.onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("renders nothing when collapsed (expand button is in Dashboard header)", () => {
    const { container } = render(<ProjectSidebar {...defaultProps} collapsed={true} />);
    expect(screen.queryByText("Projects")).toBeNull();
    expect(container.innerHTML).toBe("");
  });

  // --- Width / resize tests ---

  it("applies width style when expanded", () => {
    const { container } = render(<ProjectSidebar {...defaultProps} width={240} />);
    const aside = container.querySelector("aside");
    expect(aside?.style.width).toBe("240px");
  });

  it("renders drag handle", () => {
    render(<ProjectSidebar {...defaultProps} />);
    expect(screen.getByTestId("sidebar-drag-handle")).toBeInTheDocument();
  });

  it("drag handle triggers resize on mouse events", () => {
    render(<ProjectSidebar {...defaultProps} width={200} />);
    const handle = screen.getByTestId("sidebar-drag-handle");

    // Start drag
    fireEvent.mouseDown(handle, { clientX: 200 });

    // Move mouse - should call onWidthChange
    fireEvent.mouseMove(document, { clientX: 250 });
    expect(defaultProps.onWidthChange).toHaveBeenCalledWith(250);

    // Stop drag
    fireEvent.mouseUp(document);

    // Further mouse moves should NOT call onWidthChange again
    defaultProps.onWidthChange.mockClear();
    fireEvent.mouseMove(document, { clientX: 300 });
    expect(defaultProps.onWidthChange).not.toHaveBeenCalled();
  });

  it("clamps width to min 160px", () => {
    render(<ProjectSidebar {...defaultProps} width={200} />);
    const handle = screen.getByTestId("sidebar-drag-handle");

    fireEvent.mouseDown(handle, { clientX: 200 });
    // Drag far left to try to go below min
    fireEvent.mouseMove(document, { clientX: 50 });
    expect(defaultProps.onWidthChange).toHaveBeenCalledWith(160);
  });

  it("clamps width to max 320px", () => {
    render(<ProjectSidebar {...defaultProps} width={200} />);
    const handle = screen.getByTestId("sidebar-drag-handle");

    fireEvent.mouseDown(handle, { clientX: 200 });
    // Drag far right to try to go above max
    fireEvent.mouseMove(document, { clientX: 500 });
    expect(defaultProps.onWidthChange).toHaveBeenCalledWith(320);
  });
});

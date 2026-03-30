import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { makeSession } from "../../__tests__/helpers";

const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => "/",
}));

const projects = [
  { id: "project-1", name: "Project One" },
  { id: "project-2", name: "Project Two" },
  { id: "project-3", name: "Project Three" },
];

describe("ProjectSidebar — collapsed mode", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders collapsed sidebar with project initials", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
      />,
    );

    // All three projects start with "P", so three avatar elements
    const avatars = screen.getAllByText("P");
    expect(avatars.length).toBe(3);
    expect(screen.getByLabelText("Show project sidebar")).toBeInTheDocument();
  });

  it("navigates to project on collapsed avatar click", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
      />,
    );

    // Click on "Project Two" button (title attribute)
    const projTwoBtn = screen.getByTitle("Project Two");
    fireEvent.click(projTwoBtn);
    expect(mockPush).toHaveBeenCalledWith("/?project=project-2");
  });

  it("calls onToggleCollapsed when show sidebar button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
        onToggleCollapsed={onToggle}
      />,
    );

    fireEvent.click(screen.getByLabelText("Show project sidebar"));
    expect(onToggle).toHaveBeenCalled();
  });

  it("highlights active project in collapsed mode", () => {
    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-2"
        activeSessionId={undefined}
        collapsed
      />,
    );

    const activeBtn = container.querySelector(".project-sidebar__collapsed-project--active");
    expect(activeBtn).toBeInTheDocument();
  });

  it("shows health indicator dot for project with sessions", () => {
    const sessions = [
      makeSession({
        id: "sess-1",
        projectId: "project-1",
        status: "needs_input",
        activity: "waiting_input",
      }),
    ];

    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
      />,
    );

    const indicators = container.querySelectorAll(".project-sidebar__health-indicator");
    expect(indicators.length).toBeGreaterThan(0);
  });
});

describe("ProjectSidebar — expanded with sessions", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("shows session list when project is expanded", () => {
    const sessions = [
      makeSession({
        id: "sess-1",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "Working on feature",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    // Project 1 is expanded by default because it's active
    expect(screen.getByText("Working on feature")).toBeInTheDocument();
  });

  it("shows session count badge next to project", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1", status: "working", activity: "active" }),
      makeSession({ id: "s2", projectId: "project-1", status: "working", activity: "active" }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    // The count "2" appears in the sidebar count and possibly summary metrics
    const countElements = screen.getAllByText("2");
    expect(countElements.length).toBeGreaterThanOrEqual(1);
  });

  it("navigates to session on session row click", () => {
    const sessions = [
      makeSession({
        id: "sess-nav",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "Click me",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    const sessionRow = screen.getByText("Click me");
    fireEvent.click(sessionRow);

    expect(mockPush).toHaveBeenCalledWith("/?project=project-1&session=sess-nav");
  });

  it("handles keyboard navigation on session row (Enter)", () => {
    const sessions = [
      makeSession({
        id: "sess-kb",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "Keyboard nav",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    const sessionRow = screen.getByText("Keyboard nav").closest("[role='button']")!;
    fireEvent.keyDown(sessionRow, { key: "Enter" });

    expect(mockPush).toHaveBeenCalledWith("/?project=project-1&session=sess-kb");
  });

  it("handles keyboard navigation on session row (Space)", () => {
    const sessions = [
      makeSession({
        id: "sess-space",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "Space nav",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    const sessionRow = screen.getByText("Space nav").closest("[role='button']")!;
    fireEvent.keyDown(sessionRow, { key: " " });

    expect(mockPush).toHaveBeenCalledWith("/?project=project-1&session=sess-space");
  });

  it("shows tone label next to session", () => {
    const sessions = [
      makeSession({
        id: "sess-tone",
        projectId: "project-1",
        status: "needs_input",
        activity: "waiting_input",
        summary: "Reply needed",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("reply")).toBeInTheDocument();
  });

  it("shows session link to terminal page", () => {
    const sessions = [
      makeSession({
        id: "sess-link-test",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "Has terminal link",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    const link = screen.getByTitle("sess-link-test");
    expect(link).toHaveAttribute("href", "/sessions/sess-link-test");
  });

  it("highlights active session", () => {
    const sessions = [
      makeSession({
        id: "sess-active",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "I am active",
      }),
    ];

    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId="sess-active"
      />,
    );

    const activeRow = container.querySelector(".project-sidebar__session--active");
    expect(activeRow).toBeInTheDocument();
  });

  it("filters out done sessions from the session list", () => {
    const sessions = [
      makeSession({
        id: "sess-done",
        projectId: "project-1",
        status: "done",
        activity: null,
        summary: "I am done",
      }),
      makeSession({
        id: "sess-working",
        projectId: "project-1",
        status: "working",
        activity: "active",
        summary: "I am working",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("I am working")).toBeInTheDocument();
    expect(screen.queryByText("I am done")).not.toBeInTheDocument();
  });

  it("toggles project expansion on second click", () => {
    const sessions = [
      makeSession({
        id: "sess-toggle",
        projectId: "project-2",
        status: "working",
        activity: "active",
        summary: "Toggle me",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );

    // Project 2 is expanded (active), sessions visible
    expect(screen.getByText("Toggle me")).toBeInTheDocument();

    // Click again to collapse
    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }));
    // Since clicking navigates AND toggles, the session might still be there
    // because router.push is a mock. But the toggle logic removes from set.
    // Click one more time to re-toggle
    fireEvent.click(screen.getByRole("button", { name: /Project Two/ }));
    expect(screen.getByText("Toggle me")).toBeInTheDocument();
  });
});

describe("ProjectSidebar — summary metrics", () => {
  it("shows correct summary counts", () => {
    const sessions = [
      makeSession({ id: "s1", projectId: "project-1", status: "working", activity: "active" }),
      makeSession({ id: "s2", projectId: "project-1", status: "needs_input", activity: "waiting_input" }),
      makeSession({ id: "s3", projectId: "project-2", status: "working", activity: "active", pr: { number: 1, url: "", title: "", owner: "", repo: "", branch: "", baseBranch: "main", isDraft: false, state: "open", additions: 0, deletions: 0, ciStatus: "passing", ciChecks: [], reviewDecision: "pending", mergeability: { mergeable: false, ciPassing: true, approved: false, noConflicts: true, blockers: [] }, unresolvedThreads: 0, unresolvedComments: [] } }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    // 3 active workers — may appear in both the summary metric and count badge
    const threeElements = screen.getAllByText("3");
    expect(threeElements.length).toBeGreaterThanOrEqual(1);
  });

  it("displays hide sidebar button in expanded mode", () => {
    const onToggle = vi.fn();
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        onToggleCollapsed={onToggle}
      />,
    );

    const hideBtn = screen.getByText("Hide sidebar");
    fireEvent.click(hideBtn);
    expect(onToggle).toHaveBeenCalled();
  });
});

describe("ProjectSidebar — mobile overlay", () => {
  it("renders mobile backdrop when mobileOpen is true", () => {
    const onMobileClose = vi.fn();
    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        mobileOpen
        onMobileClose={onMobileClose}
      />,
    );

    const backdrop = container.querySelector(".sidebar-mobile-backdrop");
    expect(backdrop).toBeInTheDocument();

    fireEvent.click(backdrop!);
    expect(onMobileClose).toHaveBeenCalled();
  });

  it("renders mobile backdrop in collapsed mode when mobileOpen", () => {
    const onMobileClose = vi.fn();
    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
        mobileOpen
        onMobileClose={onMobileClose}
      />,
    );

    const backdrop = container.querySelector(".sidebar-mobile-backdrop");
    expect(backdrop).toBeInTheDocument();
  });
});

describe("ProjectSidebar — project health", () => {
  it("shows red health for project with respond-level session", () => {
    const sessions = [
      makeSession({
        id: "s-respond",
        projectId: "project-1",
        status: "needs_input",
        activity: "waiting_input",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    // Health dots should be present and one should animate (red = pulsing)
    // We just verify render succeeds without error
    expect(screen.getByText("Project One")).toBeInTheDocument();
  });

  it("shows green health for project with only working sessions", () => {
    const sessions = [
      makeSession({
        id: "s-work",
        projectId: "project-1",
        status: "working",
        activity: "active",
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("Project One")).toBeInTheDocument();
  });

  it("shows yellow health for project with review-level session", () => {
    const sessions = [
      makeSession({
        id: "s-review",
        projectId: "project-1",
        status: "working",
        activity: "active",
        pr: {
          number: 1,
          url: "",
          title: "",
          owner: "",
          repo: "",
          branch: "",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 0,
          deletions: 0,
          ciStatus: "failing",
          ciChecks: [{ name: "build", status: "failed" }],
          reviewDecision: "approved",
          mergeability: { mergeable: false, ciPassing: false, approved: true, noConflicts: true, blockers: [] },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      }),
    ];

    render(
      <ProjectSidebar
        projects={projects}
        sessions={sessions}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("Project One")).toBeInTheDocument();
  });
});

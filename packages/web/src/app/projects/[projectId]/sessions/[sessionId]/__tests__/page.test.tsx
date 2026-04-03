import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: (props: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{props.children}</div>
  ),
}));

vi.mock("@/components/ProjectSessionPageClient", () => ({
  ProjectSessionPageClient: (props: { projectId: string; sessionId: string }) => (
    <div
      data-testid="session-client"
      data-project-id={props.projectId}
      data-session-id={props.sessionId}
    />
  ),
}));

vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: vi.fn().mockReturnValue("/home/user"),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: vi.fn(),
}));

vi.mock("@/lib/project-page-data", () => ({
  loadProjectPageData: vi.fn(),
}));

vi.mock("@/lib/portfolio-page-data", () => ({
  loadPortfolioPageData: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { redirect } from "next/navigation";
import { getAllProjects } from "@/lib/project-name";
import { loadProjectPageData } from "@/lib/project-page-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import ProjectSessionPage from "../page";

const mockRedirect = vi.mocked(redirect);
const mockGetAllProjects = vi.mocked(getAllProjects);
const mockLoadProjectPageData = vi.mocked(loadProjectPageData);
const mockLoadPortfolioPageData = vi.mocked(loadPortfolioPageData);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllProjects.mockReturnValue([{ id: "my-app", name: "My App" }]);
  mockRedirect.mockImplementation((() => {
    throw new Error("NEXT_REDIRECT");
  }) as unknown as typeof redirect);
  mockLoadProjectPageData.mockResolvedValue({
    sessions: [],
    sidebarSessions: [],
    globalPause: null,
    orchestrators: [],
  });
  mockLoadPortfolioPageData.mockResolvedValue({
    projectSummaries: [],
    sessions: [],
  });
});

describe("ProjectSessionPage", () => {
  it("renders DashboardShell wrapping ProjectSessionPageClient", async () => {
    render(
      await ProjectSessionPage({
        params: Promise.resolve({ projectId: "my-app", sessionId: "sess-1" }),
      }),
    );

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    const client = screen.getByTestId("session-client");
    expect(client).toHaveAttribute("data-project-id", "my-app");
    expect(client).toHaveAttribute("data-session-id", "sess-1");
  });

  it("loads project and portfolio data concurrently", async () => {
    mockGetAllProjects.mockReturnValue([
      { id: "my-app", name: "My App" },
      { id: "proj-2", name: "Project 2" },
    ]);

    render(
      await ProjectSessionPage({
        params: Promise.resolve({ projectId: "proj-2", sessionId: "sess-x" }),
      }),
    );

    expect(mockLoadProjectPageData).toHaveBeenCalledWith("proj-2");
    expect(mockLoadPortfolioPageData).toHaveBeenCalled();
  });

  it("redirects home when the project no longer exists", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "other", name: "Other" }]);

    await ProjectSessionPage({
      params: Promise.resolve({ projectId: "my-app", sessionId: "sess-1" }),
    }).catch(() => {});

    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(mockLoadProjectPageData).not.toHaveBeenCalled();
    expect(mockLoadPortfolioPageData).not.toHaveBeenCalled();
  });
});

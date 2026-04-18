import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: () => true,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: (props: Record<string, unknown>) => (
    <div
      data-testid="dashboard"
      data-project-id={props.projectId}
      data-sidebar-sessions={Array.isArray(props.sidebarSessions) ? props.sidebarSessions.length : -1}
    />
  ),
}));

vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: (props: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{props.children}</div>
  ),
}));

vi.mock("@/components/ProjectDegradedState", () => ({
  ProjectDegradedState: (props: { projectId: string; reason?: string }) => (
    <div
      data-testid="project-degraded"
      data-project-id={props.projectId}
      data-reason={props.reason ?? ""}
    />
  ),
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

vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: vi.fn().mockReturnValue("/home/user"),
}));

import { render, screen } from "@testing-library/react";
import { redirect } from "next/navigation";
import { getAllProjects } from "@/lib/project-name";
import { loadProjectPageData } from "@/lib/project-page-data";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import ProjectPage, { generateMetadata } from "../page";

const mockGetAllProjects = vi.mocked(getAllProjects);
const mockLoadProjectPageData = vi.mocked(loadProjectPageData);
const mockLoadPortfolioPageData = vi.mocked(loadPortfolioPageData);
const mockRedirect = vi.mocked(redirect);

const fakePageData = {
  sessions: [],
  sidebarSessions: [],
  globalPause: null,
  orchestrators: [],
};

const fakePortfolioData = {
  projectSummaries: [],
  sessions: [],
  orphanedSessionCount: 0,
  orphanedProjectPaths: [],
};

const fakeProjects = [
  { id: "my-app", name: "My App" },
  { id: "other", name: "Other Project" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllProjects.mockReturnValue(fakeProjects);
  mockLoadProjectPageData.mockResolvedValue(fakePageData);
  mockLoadPortfolioPageData.mockResolvedValue(fakePortfolioData);
  mockRedirect.mockImplementation((() => {
    throw new Error("NEXT_REDIRECT");
  }) as unknown as typeof redirect);
});

describe("ProjectPage", () => {
  it("renders DashboardShell and Dashboard for a valid project", async () => {
    render(
      await ProjectPage({ params: Promise.resolve({ projectId: "my-app" }) }),
    );

    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard")).toHaveAttribute(
      "data-project-id",
      "my-app",
    );
    expect(screen.getByTestId("dashboard")).toHaveAttribute("data-sidebar-sessions", "0");
  });

  it("redirects home when project does not exist", async () => {
    await ProjectPage({ params: Promise.resolve({ projectId: "nonexistent" }) }).catch(() => {});

    expect(mockRedirect).toHaveBeenCalledWith("/");
    expect(mockLoadProjectPageData).not.toHaveBeenCalled();
  });

  it("loads project page data and portfolio data", async () => {
    render(
      await ProjectPage({ params: Promise.resolve({ projectId: "my-app" }) }),
    );

    expect(mockLoadProjectPageData).toHaveBeenCalledWith("my-app");
    expect(mockLoadPortfolioPageData).toHaveBeenCalled();
  });

  it("renders degraded project state instead of dashboard for degraded projects", async () => {
    mockGetAllProjects.mockReturnValue([
      { id: "my-app", name: "My App", degraded: true, degradedReason: "Malformed local config" },
    ]);

    render(
      await ProjectPage({ params: Promise.resolve({ projectId: "my-app" }) }),
    );

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("project-degraded")).toHaveAttribute("data-project-id", "my-app");
    expect(screen.getByTestId("project-degraded")).toHaveAttribute("data-reason", "Malformed local config");
    expect(mockLoadProjectPageData).not.toHaveBeenCalled();
  });
});

describe("generateMetadata", () => {
  it("returns title with project name", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ projectId: "my-app" }),
    });

    expect(metadata.title).toEqual({ absolute: "ao | My App" });
  });

  it("falls back to projectId when project is not found", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ projectId: "unknown" }),
    });

    expect(metadata.title).toEqual({ absolute: "ao | unknown" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: () => true,
}));

vi.mock("@/components/PullRequestsPage", () => ({
  PullRequestsPage: (props: Record<string, unknown>) => (
    <div data-testid="prs-page" data-project-id={props.projectId} />
  ),
}));

vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: (props: { children: React.ReactNode }) => (
    <div data-testid="dashboard-shell">{props.children}</div>
  ),
}));

vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: vi.fn().mockReturnValue("/home/user"),
}));

vi.mock("@/lib/portfolio-page-data", () => ({
  loadPortfolioPageData: vi.fn(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: vi.fn(),
  getDashboardProjectName: vi.fn(),
  resolveDashboardProjectFilter: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import {
  getDashboardPageData,
  getDashboardProjectName,
  resolveDashboardProjectFilter,
} from "@/lib/dashboard-page-data";
import PullRequestsRoute, { generateMetadata } from "../page";

const mockGetDashboardPageData = vi.mocked(getDashboardPageData);
const mockGetDashboardProjectName = vi.mocked(getDashboardProjectName);
const mockResolveDashboardProjectFilter = vi.mocked(resolveDashboardProjectFilter);
const mockLoadPortfolioPageData = vi.mocked(loadPortfolioPageData);

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveDashboardProjectFilter.mockReturnValue("my-app");
  mockGetDashboardProjectName.mockReturnValue("My App");
  mockGetDashboardPageData.mockResolvedValue({
    sessions: [],
    globalPause: null,
    orchestrators: [],
    projectName: "My App",
    projects: [],
    selectedProjectId: "my-app",
  });
  mockLoadPortfolioPageData.mockResolvedValue({
    projectSummaries: [],
    sessions: [],
  });
});

describe("PullRequestsRoute", () => {
  it("renders DashboardShell with PullRequestsPage", async () => {
    render(
      await PullRequestsRoute({
        searchParams: Promise.resolve({ project: "my-app" }),
      }),
    );

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("prs-page")).toBeInTheDocument();
    expect(screen.getByTestId("prs-page")).toHaveAttribute(
      "data-project-id",
      "my-app",
    );
  });

  it("resolves project filter from searchParams", async () => {
    render(
      await PullRequestsRoute({
        searchParams: Promise.resolve({ project: "other" }),
      }),
    );

    expect(mockResolveDashboardProjectFilter).toHaveBeenCalledWith("other");
  });

  it("works without project searchParam", async () => {
    render(
      await PullRequestsRoute({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(mockResolveDashboardProjectFilter).toHaveBeenCalledWith(undefined);
  });
});

describe("generateMetadata", () => {
  it("returns title with project name and PRs suffix", async () => {
    const metadata = await generateMetadata({
      searchParams: Promise.resolve({ project: "my-app" }),
    });

    expect(metadata.title).toEqual({ absolute: "ao | My App PRs" });
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: () => true,
}));

vi.mock("@/components/ActivityFeedPage", () => ({
  ActivityFeedPage: (props: Record<string, unknown>) => (
    <div
      data-testid="activity-feed"
      data-items-count={Array.isArray(props.activityItems) ? props.activityItems.length : 0}
    />
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

vi.mock("@/lib/home-activity-data", () => ({
  loadHomeActivityData: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { loadPortfolioPageData } from "@/lib/portfolio-page-data";
import { loadHomeActivityData } from "@/lib/home-activity-data";
import ActivityPage from "../page";

const mockLoadPortfolioPageData = vi.mocked(loadPortfolioPageData);
const mockLoadHomeActivityData = vi.mocked(loadHomeActivityData);

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadPortfolioPageData.mockResolvedValue({
    projectSummaries: [],
    sessions: [],
  });
  mockLoadHomeActivityData.mockResolvedValue({
    activityItems: [],
  });
});

describe("ActivityPage", () => {
  it("renders DashboardShell with ActivityFeedPage", async () => {
    render(await ActivityPage());

    expect(screen.getByTestId("dashboard-shell")).toBeInTheDocument();
    expect(screen.getByTestId("activity-feed")).toBeInTheDocument();
  });

  it("loads portfolio and activity data concurrently", async () => {
    render(await ActivityPage());

    expect(mockLoadPortfolioPageData).toHaveBeenCalled();
    expect(mockLoadHomeActivityData).toHaveBeenCalled();
  });

  it("passes activity items to ActivityFeedPage", async () => {
    mockLoadHomeActivityData.mockResolvedValue({
      activityItems: [
        { id: "1", type: "session_created", timestamp: Date.now() },
        { id: "2", type: "pr_opened", timestamp: Date.now() },
      ],
    });

    render(await ActivityPage());

    expect(screen.getByTestId("activity-feed")).toHaveAttribute(
      "data-items-count",
      "2",
    );
  });
});

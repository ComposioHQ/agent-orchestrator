import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetAllProjects = vi.fn();
const mockGetDashboardPageData = vi.fn();
const mockGetDashboardProjectName = vi.fn();
const mockResolveDashboardProjectFilter = vi.fn();

vi.mock("@/lib/project-name", () => ({
  getAllProjects: () => mockGetAllProjects(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: (...args: unknown[]) => mockGetDashboardPageData(...args),
  getDashboardProjectName: (...args: unknown[]) => mockGetDashboardProjectName(...args),
  resolveDashboardProjectFilter: (...args: unknown[]) => mockResolveDashboardProjectFilter(...args),
}));

vi.mock("@/components/PortfolioPage", () => ({
  PortfolioPage: ({ projects }: { projects: { id: string; name: string }[] }) => (
    <div data-testid="portfolio-page">{projects.map((p) => p.name).join(",")}</div>
  ),
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: ({ projectId }: { projectId: string }) => (
    <div data-testid="dashboard">{projectId}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  global.EventSource = Object.assign(vi.fn(() => ({ onmessage: null, onerror: null, close: vi.fn() })), {
    CONNECTING: 0, OPEN: 1, CLOSED: 2,
  }) as unknown as typeof EventSource;
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const loadPage = () => import("../page.js").then((m) => m.default);

describe("Home page", () => {
  it("renders PortfolioPage when multiple projects and no project filter", async () => {
    mockGetAllProjects.mockReturnValue([
      { id: "ao", name: "Agent Orchestrator" },
      { id: "ds", name: "Docs Server" },
    ]);

    const Home = await loadPage();
    const el = await Home({ searchParams: Promise.resolve({}) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
    expect(screen.getByText(/Agent Orchestrator/)).toBeInTheDocument();
  });

  it("renders PortfolioPage when zero projects", async () => {
    mockGetAllProjects.mockReturnValue([]);

    const Home = await loadPage();
    const el = await Home({ searchParams: Promise.resolve({}) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("portfolio-page")).toBeInTheDocument();
  });

  it("renders Dashboard for single project with no filter", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "ao", name: "AO" }]);
    mockResolveDashboardProjectFilter.mockReturnValue("ao");
    mockGetDashboardPageData.mockResolvedValue({
      sessions: [],
      selectedProjectId: "ao",
      projectName: "AO",
      projects: [{ id: "ao", name: "AO" }],
      globalPause: null,
      orchestrators: [],
    });

    const Home = await loadPage();
    const el = await Home({ searchParams: Promise.resolve({}) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.getByText("ao")).toBeInTheDocument();
  });

  it("renders Dashboard when explicit project filter is set", async () => {
    mockGetAllProjects.mockReturnValue([
      { id: "ao", name: "AO" },
      { id: "ds", name: "DS" },
    ]);
    mockResolveDashboardProjectFilter.mockReturnValue("ao");
    mockGetDashboardPageData.mockResolvedValue({
      sessions: [],
      selectedProjectId: "ao",
      projectName: "AO",
      projects: [{ id: "ao", name: "AO" }],
      globalPause: null,
      orchestrators: [],
    });

    const Home = await loadPage();
    const el = await Home({ searchParams: Promise.resolve({ project: "ao" }) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
  });
});

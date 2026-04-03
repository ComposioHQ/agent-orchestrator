import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockNotFound = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/ao",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => mockNotFound(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mockGetAllProjects = vi.fn();
const mockGetDashboardPageData = vi.fn();
const mockGetDashboardProjectName = vi.fn();

vi.mock("@/lib/project-name", () => ({
  getAllProjects: () => mockGetAllProjects(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: (...args: unknown[]) => mockGetDashboardPageData(...args),
  getDashboardProjectName: (...args: unknown[]) => mockGetDashboardProjectName(...args),
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: ({ projectId }: { projectId: string }) => (
    <div data-testid="dashboard">{projectId}</div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockNotFound.mockReset();
  // In real Next.js, notFound() throws a special error to halt execution.
  // Without this, the mock returns undefined and execution continues past
  // the guard into getDashboardPageData(), causing a TypeError.
  mockNotFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const loadPage = () => import("../projects/[id]/page.js").then((m) => m.default);

describe("ProjectPage", () => {
  it("renders Dashboard for a known project", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "ao", name: "AO" }]);
    mockGetDashboardPageData.mockResolvedValue({
      sessions: [],
      selectedProjectId: "ao",
      projectName: "AO",
      projects: [{ id: "ao", name: "AO" }],
      globalPause: null,
      orchestrators: [],
    });

    const ProjectPage = await loadPage();
    const el = await ProjectPage({ params: Promise.resolve({ id: "ao" }) });
    render(el as React.ReactElement);

    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    expect(screen.getByText("ao")).toBeInTheDocument();
  });

  it("calls notFound for an unknown project ID", async () => {
    mockGetAllProjects.mockReturnValue([{ id: "ao", name: "AO" }]);

    const ProjectPage = await loadPage();
    // notFound() throws in Next.js — the mock replicates this so execution halts
    await expect(ProjectPage({ params: Promise.resolve({ id: "unknown" }) })).rejects.toThrow();

    expect(mockNotFound).toHaveBeenCalled();
  });
});

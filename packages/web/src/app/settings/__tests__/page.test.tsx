import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock next/navigation (used by DashboardShell children)
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/settings",
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock @aoagents/ao-core
vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: () => true,
  loadConfig: () => ({
    defaults: {
      agent: "claude-code",
      workspace: "worktree",
    },
  }),
  loadPreferences: () => ({}),
  loadGlobalConfig: () => null,
  isProjectShadowStale: () => false,
}));

// Mock portfolio-services
vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: () => ({
    portfolio: [
      {
        id: "proj-1",
        name: "Test Project",
        repo: "org/repo",
        repoPath: "/home/user/repos/test",
        configPath: "/home/user/repos/test/ao.yaml",
        defaultBranch: "main",
        sessionPrefix: "tp",
        enabled: true,
        pinned: false,
        source: "local",
      },
    ],
    preferences: { projectOrder: ["proj-1"], defaultProject: "" },
  }),
  getCachedPortfolioSessions: () => Promise.resolve([]),
}));

// Mock default-location
vi.mock("@/lib/default-location", () => ({
  getDefaultCloneLocation: () => "/home/user",
}));

// Mock DashboardShell to avoid pulling in full sidebar + modal tree
vi.mock("@/components/DashboardShell", () => ({
  DashboardShell: ({ children }: { children: React.ReactNode }) => <div data-testid="shell">{children}</div>,
}));

// Mock AddProjectModal used inside ProjectSettings
vi.mock("@/components/AddProjectModal", () => ({
  AddProjectModal: () => null,
}));

// Mock IntegrationSettings since it fetches on mount
vi.mock("@/components/settings/IntegrationSettings", () => ({
  IntegrationSettings: () => <div data-testid="integration-settings">Integrations</div>,
}));

import SettingsRoute from "../page";

describe("SettingsRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agents: [] }),
    }) as unknown as typeof fetch;
  });

  it("renders the settings page with heading", async () => {
    const Page = await SettingsRoute();
    render(Page);

    expect(screen.getByText("Configure your portfolio")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders ProjectSettings section with project data", async () => {
    const Page = await SettingsRoute();
    render(Page);

    expect(screen.getByText("Projects & Repos")).toBeInTheDocument();
    expect(screen.getByText("Test Project")).toBeInTheDocument();
  });

  it("renders AgentSettings section with defaults", async () => {
    const Page = await SettingsRoute();
    render(Page);

    expect(screen.getByText("Agent Defaults")).toBeInTheDocument();
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("worktree")).toBeInTheDocument();
  });

  it("renders IntegrationSettings section", async () => {
    const Page = await SettingsRoute();
    render(Page);

    expect(screen.getByTestId("integration-settings")).toBeInTheDocument();
  });

  it("wraps content in DashboardShell", async () => {
    const Page = await SettingsRoute();
    render(Page);

    expect(screen.getByTestId("shell")).toBeInTheDocument();
  });
});

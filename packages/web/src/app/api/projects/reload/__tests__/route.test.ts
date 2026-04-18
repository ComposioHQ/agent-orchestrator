import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIsPortfolioEnabled = vi.fn(() => true);
const mockReloadServices = vi.fn();
const mockGetPortfolioServices = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  isPortfolioEnabled: () => mockIsPortfolioEnabled(),
}));

vi.mock("@/lib/services", () => ({
  reloadServices: (...args: unknown[]) => mockReloadServices(...args),
}));

vi.mock("@/lib/portfolio-services", () => ({
  getPortfolioServices: (...args: unknown[]) => mockGetPortfolioServices(...args),
}));

describe("POST /api/projects/reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPortfolioEnabled.mockReturnValue(true);
    mockReloadServices.mockResolvedValue({
      config: {
        configPath: "/tmp/.agent-orchestrator/config.yaml",
        projects: {
          alpha: {},
          beta: {},
        },
      },
    });
    mockGetPortfolioServices.mockReturnValue({
      portfolio: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
    });
  });

  it("returns 404 when portfolio mode is disabled", async () => {
    mockIsPortfolioEnabled.mockReturnValue(false);
    const { POST } = await import("../route");

    const response = await POST();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Portfolio mode is disabled",
    });
  });

  it("reloads services and returns refreshed counts", async () => {
    const { POST } = await import("../route");

    const response = await POST();

    expect(mockReloadServices).toHaveBeenCalledTimes(1);
    expect(mockGetPortfolioServices).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      configPath: "/tmp/.agent-orchestrator/config.yaml",
      projectCount: 2,
      portfolioProjectCount: 3,
    });
  });

  it("returns 500 when reload fails", async () => {
    mockReloadServices.mockRejectedValueOnce(new Error("reload exploded"));
    const { POST } = await import("../route");

    const response = await POST();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "reload exploded",
    });
  });
});

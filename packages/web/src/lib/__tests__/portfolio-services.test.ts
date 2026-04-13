import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetPortfolio = vi.fn(() => []);
const mockLoadConfig = vi.fn();
const mockLoadPreferences = vi.fn(() => ({ version: 1 }));
const mockListPortfolioSessions = vi.fn();
const mockGenerateSessionPrefix = vi.fn((id: string) => `${id}-`);
const mockIsPortfolioEnabled = vi.fn(() => true);

vi.mock("@aoagents/ao-core", () => ({
  getPortfolio: () => mockGetPortfolio(),
  loadConfig: () => mockLoadConfig(),
  loadPreferences: () => mockLoadPreferences(),
  listPortfolioSessions: (...args: unknown[]) => mockListPortfolioSessions(...args),
  generateSessionPrefix: (id: string) => mockGenerateSessionPrefix(id),
  isPortfolioEnabled: () => mockIsPortfolioEnabled(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Clean up globalThis cache
  const g = globalThis as Record<string, unknown>;
  if (g._aoPortfolioRefreshTimer) {
    clearInterval(g._aoPortfolioRefreshTimer as ReturnType<typeof setInterval>);
  }
  delete g._aoPortfolioCache;
  delete g._aoPortfolioRefreshTimer;
  mockIsPortfolioEnabled.mockReturnValue(true);
});

import {
  stopPortfolioBackgroundRefresh,
  getPortfolioServices,
  getCachedPortfolioSessions,
} from "../portfolio-services";

describe("stopPortfolioBackgroundRefresh", () => {
  it("clears the background refresh timer", () => {
    // Trigger background refresh by calling getPortfolioServices
    getPortfolioServices();
    const g = globalThis as Record<string, unknown>;
    expect(g._aoPortfolioRefreshTimer).toBeDefined();

    stopPortfolioBackgroundRefresh();
    expect(g._aoPortfolioRefreshTimer).toBeUndefined();
  });

  it("is safe to call when no timer exists", () => {
    expect(() => stopPortfolioBackgroundRefresh()).not.toThrow();
  });
});

describe("getPortfolioServices", () => {
  it("returns portfolio and preferences", () => {
    const portfolio = [{ id: "p1", name: "Project 1" }];
    mockGetPortfolio.mockReturnValue(portfolio);
    mockLoadPreferences.mockReturnValue({ version: 1 });

    const services = getPortfolioServices();
    expect(services.portfolio).toEqual(portfolio);
    expect(services.preferences).toEqual({ version: 1 });

    // Cleanup
    stopPortfolioBackgroundRefresh();
  });

  it("falls back to config when portfolio is empty", () => {
    mockGetPortfolio.mockReturnValue([]);
    mockLoadConfig.mockReturnValue({
      configPath: "/home/user/config.yaml",
      projects: {
        "my-app": {
          name: "My App",
          path: "/home/user/app",
          repo: "org/app",
          defaultBranch: "main",
        },
      },
    });

    const services = getPortfolioServices();
    expect(services.portfolio).toHaveLength(1);
    expect(services.portfolio[0].name).toBe("My App");
    expect(services.portfolio[0].id).toBe("my-app");

    stopPortfolioBackgroundRefresh();
  });

  it("uses legacy config fallback when portfolio mode is disabled", () => {
    mockIsPortfolioEnabled.mockReturnValue(false);
    mockLoadConfig.mockReturnValue({
      configPath: "/home/user/config.yaml",
      projects: {
        "legacy-app": {
          name: "Legacy App",
          path: "/home/user/app",
          repo: "org/app",
          defaultBranch: "main",
        },
      },
    });

    const services = getPortfolioServices();

    expect(services.portfolio).toEqual([
      expect.objectContaining({ id: "legacy-app", name: "Legacy App" }),
    ]);
    expect(services.preferences).toEqual({ version: 1 });
    expect(mockGetPortfolio).not.toHaveBeenCalled();
  });

  it("returns empty portfolio when both portfolio and config fail", () => {
    mockGetPortfolio.mockReturnValue([]);
    mockLoadConfig.mockImplementation(() => { throw new Error("no config"); });

    const services = getPortfolioServices();
    expect(services.portfolio).toEqual([]);

    stopPortfolioBackgroundRefresh();
  });

  it("returns cached data on subsequent calls within TTL", () => {
    const portfolio = [{ id: "p1", name: "Project 1" }];
    mockGetPortfolio.mockReturnValue(portfolio);

    const first = getPortfolioServices();
    mockGetPortfolio.mockReturnValue([{ id: "p2", name: "Changed" }]);
    const second = getPortfolioServices();

    expect(first).toBe(second);

    stopPortfolioBackgroundRefresh();
  });

  it("refreshes cache after TTL expires", () => {
    const portfolio1 = [{ id: "p1", name: "V1" }];
    const portfolio2 = [{ id: "p1", name: "V2" }];
    mockGetPortfolio.mockReturnValue(portfolio1);

    getPortfolioServices();
    mockGetPortfolio.mockReturnValue(portfolio2);

    // Advance past TTL (10s)
    vi.advanceTimersByTime(11_000);

    const result = getPortfolioServices();
    expect(result.portfolio).toEqual(portfolio2);

    stopPortfolioBackgroundRefresh();
  });
});

describe("getCachedPortfolioSessions", () => {
  it("returns sessions after loading", async () => {
    mockGetPortfolio.mockReturnValue([{ id: "p1", name: "P1" }]);
    const sessions = [{ id: "s1" }];
    mockListPortfolioSessions.mockResolvedValue(sessions);

    const result = await getCachedPortfolioSessions();
    expect(result).toEqual(sessions);

    stopPortfolioBackgroundRefresh();
  });

  it("returns empty array when session refresh fails", async () => {
    mockGetPortfolio.mockReturnValue([{ id: "p1", name: "P1" }]);
    mockListPortfolioSessions.mockRejectedValue(new Error("fail"));

    const result = await getCachedPortfolioSessions();
    expect(result).toEqual([]);

    stopPortfolioBackgroundRefresh();
  });

  it("returns cached sessions when fresh", async () => {
    mockGetPortfolio.mockReturnValue([{ id: "p1", name: "P1" }]);
    const sessions = [{ id: "s1" }];
    mockListPortfolioSessions.mockResolvedValue(sessions);

    await getCachedPortfolioSessions();
    // Second call should use cache
    const result = await getCachedPortfolioSessions();
    expect(result).toEqual(sessions);

    stopPortfolioBackgroundRefresh();
  });
});

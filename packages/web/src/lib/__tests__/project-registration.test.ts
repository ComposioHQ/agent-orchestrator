import { describe, it, expect, vi, beforeEach } from "vitest";

const mockRegisterProject = vi.fn();
const mockGetPortfolio = vi.fn(() => []);
const mockUpdatePreferences = vi.fn();
const mockStopPortfolioBackgroundRefresh = vi.fn();
const mockInvalidateServicesCache = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  getPortfolio: (...args: unknown[]) => mockGetPortfolio(...args),
  registerProject: (...args: unknown[]) => mockRegisterProject(...args),
  updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
}));

vi.mock("@/lib/portfolio-services", () => ({
  stopPortfolioBackgroundRefresh: () => mockStopPortfolioBackgroundRefresh(),
}));

vi.mock("@/lib/services", () => ({
  invalidateServicesCache: () => mockInvalidateServicesCache(),
}));

import {
  invalidatePortfolioCache,
  invalidateProjectCaches,
  registerAndResolveProject,
} from "../project-registration";

beforeEach(() => {
  vi.clearAllMocks();
  // Clean up globalThis cache
  const g = globalThis as Record<string, unknown>;
  delete g._aoPortfolioCache;
  delete g._aoPortfolioRefreshTimer;
});

describe("invalidatePortfolioCache", () => {
  it("calls stopPortfolioBackgroundRefresh", () => {
    invalidatePortfolioCache();
    expect(mockStopPortfolioBackgroundRefresh).toHaveBeenCalled();
  });
});

describe("invalidateProjectCaches", () => {
  it("calls both invalidatePortfolioCache and invalidateServicesCache", () => {
    invalidateProjectCaches();
    expect(mockStopPortfolioBackgroundRefresh).toHaveBeenCalled();
    expect(mockInvalidateServicesCache).toHaveBeenCalled();
  });
});

describe("registerAndResolveProject", () => {
  it("registers and returns the resolved project", () => {
    const project = {
      id: "proj-1",
      name: "My Project",
      repoPath: "/home/user/project",
      configProjectKey: undefined,
    };
    mockGetPortfolio.mockReturnValue([project]);

    const result = registerAndResolveProject("/home/user/project");
    expect(mockRegisterProject).toHaveBeenCalled();
    expect(result).toEqual(project);
  });

  it("throws when project cannot be resolved after registration", () => {
    mockGetPortfolio.mockReturnValue([]);

    expect(() => registerAndResolveProject("/home/user/project")).toThrow(
      "Project was registered, but could not be resolved",
    );
  });

  it("updates displayName via preferences when it differs", () => {
    const project = {
      id: "proj-1",
      name: "Original",
      repoPath: "/home/user/project",
      configProjectKey: undefined,
    };
    mockGetPortfolio.mockReturnValue([project]);

    const result = registerAndResolveProject("/home/user/project", {
      displayName: "Custom Name",
    });
    expect(mockUpdatePreferences).toHaveBeenCalled();
    expect(result.name).toBe("Custom Name");
  });

  it("does not update preferences when displayName matches", () => {
    const project = {
      id: "proj-1",
      name: "Same Name",
      repoPath: "/home/user/project",
      configProjectKey: undefined,
    };
    mockGetPortfolio.mockReturnValue([project]);

    const result = registerAndResolveProject("/home/user/project", {
      displayName: "Same Name",
    });
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    expect(result).toEqual(project);
  });

  it("matches by configProjectKey when provided", () => {
    const project = {
      id: "proj-1",
      name: "Project",
      repoPath: "/home/user/project",
      configProjectKey: "my-key",
    };
    mockGetPortfolio.mockReturnValue([project]);

    const result = registerAndResolveProject("/home/user/project", {
      configProjectKey: "my-key",
    });
    expect(result).toEqual(project);
  });
});

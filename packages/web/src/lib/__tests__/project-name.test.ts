import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.fn();
const mockLoadPreferences = vi.fn(() => ({}));
const mockGetPortfolio = vi.fn(() => []);

vi.mock("react", () => ({
  cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => mockLoadConfig(),
  loadPreferences: () => mockLoadPreferences(),
  getPortfolio: () => mockGetPortfolio(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getPrimaryProjectId", () => {
  it("returns portfolio default project id when set in preferences", async () => {
    mockLoadPreferences.mockReturnValue({ defaultProjectId: "proj-1" });
    mockGetPortfolio.mockReturnValue([{ id: "proj-1", name: "Project One" }]);

    const { getPrimaryProjectId } = await import("../project-name");
    expect(getPrimaryProjectId()).toBe("proj-1");
  });

  it("falls back to first config project key", async () => {
    mockLoadPreferences.mockReturnValue({});
    mockLoadConfig.mockReturnValue({
      projects: { "my-app": { name: "My App" } },
    });

    const { getPrimaryProjectId } = await import("../project-name");
    expect(getPrimaryProjectId()).toBe("my-app");
  });

  it("returns 'ao' when no config or portfolio is available", async () => {
    mockLoadPreferences.mockImplementation(() => { throw new Error("no prefs"); });
    mockLoadConfig.mockImplementation(() => { throw new Error("no config"); });

    const { getPrimaryProjectId } = await import("../project-name");
    expect(getPrimaryProjectId()).toBe("ao");
  });

  it("falls back to config when portfolio has no matching default", async () => {
    mockLoadPreferences.mockReturnValue({ defaultProjectId: "nonexistent" });
    mockGetPortfolio.mockReturnValue([{ id: "other", name: "Other" }]);
    mockLoadConfig.mockReturnValue({
      projects: { "fallback-app": { name: "Fallback" } },
    });

    const { getPrimaryProjectId } = await import("../project-name");
    expect(getPrimaryProjectId()).toBe("fallback-app");
  });
});

describe("getProjectName", () => {
  it("returns portfolio project name when default is set", async () => {
    mockLoadPreferences.mockReturnValue({ defaultProjectId: "proj-1" });
    mockGetPortfolio.mockReturnValue([{ id: "proj-1", name: "Project One" }]);

    const { getProjectName } = await import("../project-name");
    expect(getProjectName()).toBe("Project One");
  });

  it("falls back to config project name", async () => {
    mockLoadPreferences.mockReturnValue({});
    mockLoadConfig.mockReturnValue({
      projects: { "my-app": { name: "My App" } },
    });

    const { getProjectName } = await import("../project-name");
    expect(getProjectName()).toBe("My App");
  });

  it("uses key as name when project name is not set", async () => {
    mockLoadPreferences.mockReturnValue({});
    mockLoadConfig.mockReturnValue({
      projects: { "my-app": {} },
    });

    const { getProjectName } = await import("../project-name");
    expect(getProjectName()).toBe("my-app");
  });

  it("returns 'ao' when nothing is available", async () => {
    mockLoadPreferences.mockImplementation(() => { throw new Error("no prefs"); });
    mockLoadConfig.mockImplementation(() => { throw new Error("no config"); });

    const { getProjectName } = await import("../project-name");
    expect(getProjectName()).toBe("ao");
  });
});

describe("getAllProjects", () => {
  it("returns portfolio projects when available", async () => {
    mockGetPortfolio.mockReturnValue([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ]);

    const { getAllProjects } = await import("../project-name");
    expect(getAllProjects()).toEqual([
      { id: "a", name: "Alpha" },
      { id: "b", name: "Bravo" },
    ]);
  });

  it("falls back to config projects when portfolio is empty", async () => {
    mockGetPortfolio.mockReturnValue([]);
    mockLoadConfig.mockReturnValue({
      projects: { "my-app": { name: "My App" }, docs: {} },
    });

    const { getAllProjects } = await import("../project-name");
    expect(getAllProjects()).toEqual([
      { id: "my-app", name: "My App" },
      { id: "docs", name: "docs" },
    ]);
  });

  it("returns empty array when everything fails", async () => {
    mockGetPortfolio.mockImplementation(() => { throw new Error("fail"); });
    mockLoadConfig.mockImplementation(() => { throw new Error("fail"); });

    const { getAllProjects } = await import("../project-name");
    expect(getAllProjects()).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockLoadConfig = vi.hoisted(() => vi.fn());

vi.mock("@composio/ao-core", () => ({
  loadConfig: mockLoadConfig,
}));

// React cache is a no-op in test — just call through
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    cache: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

import { getProjectName, getPrimaryProjectId, getAllProjects } from "@/lib/project-name";

describe("getProjectName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the name of the first project", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "my-app": { name: "My Application", path: "/tmp/app" },
        "my-docs": { name: "Docs", path: "/tmp/docs" },
      },
    });
    expect(getProjectName()).toBe("My Application");
  });

  it("falls back to the project key when name is undefined", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "my-app": { path: "/tmp/app" },
      },
    });
    expect(getProjectName()).toBe("my-app");
  });

  it("returns 'ao' when projects is empty", () => {
    mockLoadConfig.mockReturnValue({ projects: {} });
    expect(getProjectName()).toBe("ao");
  });

  it("returns 'ao' when loadConfig throws", () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("Config not found");
    });
    expect(getProjectName()).toBe("ao");
  });

  it("returns project key when name is empty string", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "my-app": { name: "", path: "/tmp/app" },
      },
    });
    // name is "" which is falsy, so fallback to firstKey
    expect(getProjectName()).toBe("my-app");
  });
});

describe("getPrimaryProjectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the first project key", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "alpha": { name: "Alpha", path: "/tmp/alpha" },
        "beta": { name: "Beta", path: "/tmp/beta" },
      },
    });
    expect(getPrimaryProjectId()).toBe("alpha");
  });

  it("returns 'ao' when projects is empty", () => {
    mockLoadConfig.mockReturnValue({ projects: {} });
    expect(getPrimaryProjectId()).toBe("ao");
  });

  it("returns 'ao' when loadConfig throws", () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("Config not found");
    });
    expect(getPrimaryProjectId()).toBe("ao");
  });
});

describe("getAllProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all projects with id and name", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "alpha": { name: "Alpha Project", path: "/tmp/alpha" },
        "beta": { name: "Beta Project", path: "/tmp/beta" },
      },
    });
    const projects = getAllProjects();
    expect(projects).toEqual([
      { id: "alpha", name: "Alpha Project" },
      { id: "beta", name: "Beta Project" },
    ]);
  });

  it("uses id as name when name is not set", () => {
    mockLoadConfig.mockReturnValue({
      projects: {
        "my-app": { path: "/tmp/app" },
      },
    });
    const projects = getAllProjects();
    expect(projects).toEqual([{ id: "my-app", name: "my-app" }]);
  });

  it("returns empty array when loadConfig throws", () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("Config not found");
    });
    expect(getAllProjects()).toEqual([]);
  });

  it("returns empty array when projects is empty", () => {
    mockLoadConfig.mockReturnValue({ projects: {} });
    expect(getAllProjects()).toEqual([]);
  });
});

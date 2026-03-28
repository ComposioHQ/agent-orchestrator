import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAllProjectsMock, getPrimaryProjectIdMock, getProjectNameMock } = vi.hoisted(() => ({
  getAllProjectsMock: vi.fn(),
  getPrimaryProjectIdMock: vi.fn(),
  getProjectNameMock: vi.fn(),
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: getAllProjectsMock,
  getPrimaryProjectId: getPrimaryProjectIdMock,
  getProjectName: getProjectNameMock,
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(),
  getSCM: vi.fn(),
}));

import { resolveDashboardProjectFilter } from "@/lib/dashboard-page-data";

describe("resolveDashboardProjectFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAllProjectsMock.mockReturnValue([
      { id: "mono", name: "Mono" },
      { id: "docs", name: "Docs" },
    ]);
    getPrimaryProjectIdMock.mockReturnValue("mono");
    getProjectNameMock.mockReturnValue("Mono");
  });

  it("keeps valid project ids", () => {
    expect(resolveDashboardProjectFilter("docs")).toBe("docs");
  });

  it("keeps the all-projects sentinel", () => {
    expect(resolveDashboardProjectFilter("all")).toBe("all");
  });

  it("falls back to primary project for unknown ids", () => {
    expect(resolveDashboardProjectFilter("mono-orchestrator")).toBe("mono");
  });
});

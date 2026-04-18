import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetServices, mockExecFileAsync } = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
  mockExecFileAsync: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: () => mockExecFileAsync,
    default: {
      ...("default" in actual && actual.default ? actual.default : {}),
      promisify: () => mockExecFileAsync,
    },
  };
});

import { POST } from "../route";

describe("POST /api/setup-labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  });

  it("skips degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          healthy: { repo: "acme/healthy" },
          broken: { repo: "acme/broken", resolveError: "Malformed local config" },
        },
      },
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockExecFileAsync).toHaveBeenCalled();
    const repos = body.results.map((entry: { repo: string }) => entry.repo);
    expect(repos.every((repo: string) => repo === "acme/healthy")).toBe(true);
  });
});

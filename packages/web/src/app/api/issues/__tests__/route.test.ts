import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetServices } = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

import { GET, POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/issues", () => {
  it("GET skips degraded projects", async () => {
    const healthyListIssues = vi.fn().mockResolvedValue([
      {
        id: "123",
        title: "Healthy issue",
        url: "https://example.com/123",
        state: "open",
        labels: [],
      },
    ]);

    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          healthy: { tracker: { plugin: "github" } },
          broken: { tracker: { plugin: "github" }, resolveError: "Malformed local config" },
        },
      },
      registry: {
        get: vi.fn(() => ({ listIssues: healthyListIssues })),
      },
    });

    const response = await GET(new NextRequest("http://localhost/api/issues"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].projectId).toBe("healthy");
    expect(healthyListIssues).toHaveBeenCalledTimes(1);
  });

  it("POST returns 409 for degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          broken: { tracker: { plugin: "github" }, resolveError: "Malformed local config" },
        },
      },
      registry: { get: vi.fn() },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/issues", {
        method: "POST",
        body: JSON.stringify({ projectId: "broken", title: "Test issue" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "broken" is degraded: Malformed local config');
  });
});

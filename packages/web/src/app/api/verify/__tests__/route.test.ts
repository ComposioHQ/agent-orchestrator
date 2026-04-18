import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetServices, mockGetVerifyIssues } = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
  mockGetVerifyIssues: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
  getVerifyIssues: (...args: unknown[]) => mockGetVerifyIssues(...args),
}));

import { POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/verify", () => {
  it("returns 409 for degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          broken: { tracker: { plugin: "github" }, resolveError: "Malformed local config" },
        },
      },
      registry: { get: vi.fn() },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/verify", {
        method: "POST",
        body: JSON.stringify({ issueId: "ISSUE-1", projectId: "broken", action: "verify" }),
        headers: { "content-type": "application/json" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "broken" is degraded: Malformed local config');
  });
});

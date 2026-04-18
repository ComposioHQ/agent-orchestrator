import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetServices } = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@/lib/orchestrator-utils", () => ({
  mapSessionsToOrchestrators: vi.fn(() => []),
}));

vi.mock("@aoagents/ao-core", () => ({
  generateOrchestratorPrompt: vi.fn(() => "system prompt"),
  generateSessionPrefix: vi.fn((name: string) => name),
}));

import { GET, POST } from "../route";

function makeGetRequest(projectId: string) {
  return new NextRequest(`http://localhost/api/orchestrators?project=${encodeURIComponent(projectId)}`);
}

function makePostRequest(projectId: string) {
  return new NextRequest("http://localhost/api/orchestrators", {
    method: "POST",
    body: JSON.stringify({ projectId }),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/orchestrators", () => {
  it("GET returns 409 for degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          "my-app": { name: "My App", resolveError: "Malformed local config" },
        },
      },
      sessionManager: { list: vi.fn() },
    });

    const response = await GET(makeGetRequest("my-app"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "my-app" is degraded: Malformed local config');
  });

  it("POST returns 409 for degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          "my-app": { name: "My App", resolveError: "Malformed local config" },
        },
      },
      sessionManager: { spawnOrchestrator: vi.fn() },
    });

    const response = await POST(makePostRequest("my-app"));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "my-app" is degraded: Malformed local config');
  });
});

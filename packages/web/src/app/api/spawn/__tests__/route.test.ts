import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetServices,
  mockSessionToDashboard,
  mockGetCorrelationId,
  mockJsonWithCorrelation,
  mockRecordApiObservation,
} = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
  mockSessionToDashboard: vi.fn(),
  mockGetCorrelationId: vi.fn(),
  mockJsonWithCorrelation: vi.fn(),
  mockRecordApiObservation: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: (...args: unknown[]) => mockSessionToDashboard(...args),
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: (...args: unknown[]) => mockGetCorrelationId(...args),
  jsonWithCorrelation: (...args: unknown[]) => mockJsonWithCorrelation(...args),
  recordApiObservation: (...args: unknown[]) => mockRecordApiObservation(...args),
}));

import { POST } from "../route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/spawn", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCorrelationId.mockReturnValue("corr-1");
  mockJsonWithCorrelation.mockImplementation((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  );
});

describe("POST /api/spawn", () => {
  it("returns 409 for degraded projects", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          "my-app": { resolveError: "Malformed local config" },
        },
      },
      sessionManager: { spawn: vi.fn() },
    });

    const response = await POST(makeRequest({ projectId: "my-app" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "my-app" is degraded: Malformed local config');
  });
});

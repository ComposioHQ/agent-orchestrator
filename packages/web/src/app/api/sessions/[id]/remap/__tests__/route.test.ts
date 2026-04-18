import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetServices,
  mockGetCorrelationId,
  mockJsonWithCorrelation,
  mockRecordApiObservation,
} = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
  mockGetCorrelationId: vi.fn(),
  mockJsonWithCorrelation: vi.fn(),
  mockRecordApiObservation: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: (...args: unknown[]) => mockGetCorrelationId(...args),
  jsonWithCorrelation: (...args: unknown[]) => mockJsonWithCorrelation(...args),
  recordApiObservation: (...args: unknown[]) => mockRecordApiObservation(...args),
  resolveProjectIdForSessionId: vi.fn(() => "my-app"),
}));

import { POST } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCorrelationId.mockReturnValue("corr-1");
  mockJsonWithCorrelation.mockImplementation((body: unknown, init?: ResponseInit) =>
    Response.json(body, init),
  );
});

describe("POST /api/sessions/[id]/remap", () => {
  it("returns 409 when the session belongs to a degraded project", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          "my-app": { resolveError: "Malformed local config" },
        },
      },
      sessionManager: { remap: vi.fn() },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/sessions/sess-1/remap", { method: "POST" }),
      { params: Promise.resolve({ id: "sess-1" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "my-app" is degraded: Malformed local config');
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockGetServices,
  mockGetSCM,
  mockGetCorrelationId,
  mockJsonWithCorrelation,
  mockRecordApiObservation,
} = vi.hoisted(() => ({
  mockGetServices: vi.fn(),
  mockGetSCM: vi.fn(),
  mockGetCorrelationId: vi.fn(),
  mockJsonWithCorrelation: vi.fn(),
  mockRecordApiObservation: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
  getSCM: (...args: unknown[]) => mockGetSCM(...args),
}));

vi.mock("@/lib/observability", () => ({
  getCorrelationId: (...args: unknown[]) => mockGetCorrelationId(...args),
  jsonWithCorrelation: (...args: unknown[]) => mockJsonWithCorrelation(...args),
  recordApiObservation: (...args: unknown[]) => mockRecordApiObservation(...args),
}));

import { POST } from "../route";

function makeRequest() {
  return new NextRequest("http://localhost/api/prs/42/merge", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCorrelationId.mockReturnValue("corr-1");
  mockJsonWithCorrelation.mockImplementation((body: unknown, init?: ResponseInit) => {
    return Response.json(body, init);
  });
});

describe("POST /api/prs/[id]/merge", () => {
  it("returns 409 when the session's project is degraded", async () => {
    mockGetServices.mockResolvedValue({
      config: {
        projects: {
          "my-app": { name: "My App", resolveError: "Malformed local config" },
        },
      },
      registry: {},
      sessionManager: {
        list: vi.fn().mockResolvedValue([
          {
            id: "sess-1",
            projectId: "my-app",
            pr: { number: 42, owner: "acme", repo: "app" },
          },
        ]),
      },
    });

    const response = await POST(makeRequest(), { params: Promise.resolve({ id: "42" }) });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toBe('Project "my-app" is degraded: Malformed local config');
    expect(mockGetSCM).not.toHaveBeenCalled();
  });
});

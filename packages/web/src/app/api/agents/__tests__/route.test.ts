import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetServices = vi.fn();

vi.mock("@/lib/services", () => ({
  getServices: (...args: unknown[]) => mockGetServices(...args),
}));

import { GET } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServices.mockResolvedValue({
    registry: {
      list: vi.fn(() => [
        { name: "claude-code", displayName: "Claude Code" },
        { name: "aider", displayName: undefined },
      ]),
    },
  });
});

describe("GET /api/agents", () => {
  it("returns agents list with displayName when available", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents).toHaveLength(2);
    expect(data.agents[0]).toEqual({ id: "claude-code", name: "Claude Code" });
  });

  it("falls back to manifest name when displayName is missing", async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.agents[1]).toEqual({ id: "aider", name: "aider" });
  });

  it("returns 500 when getServices throws", async () => {
    mockGetServices.mockRejectedValueOnce(new Error("service unavailable"));
    const res = await GET();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("service unavailable");
  });

  it("returns generic error for non-Error throws", async () => {
    mockGetServices.mockRejectedValueOnce("string error");
    const res = await GET();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Failed to load agents");
  });

  it("returns empty agents array when none registered", async () => {
    mockGetServices.mockResolvedValueOnce({
      registry: { list: vi.fn(() => []) },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agents).toEqual([]);
  });
});

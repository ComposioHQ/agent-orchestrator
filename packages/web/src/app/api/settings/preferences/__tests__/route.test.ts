import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock ao-core ──────────────────────────────────────────────────────
const mockPortfolio = [
  { id: "proj-a", name: "Project A" },
  { id: "proj-b", name: "Project B" },
];

let storedPreferences: Record<string, unknown> = {};

vi.mock("@aoagents/ao-core", () => ({
  getPortfolio: vi.fn(() => mockPortfolio),
  loadPreferences: vi.fn(() => storedPreferences),
  updatePreferences: vi.fn((updater: (prefs: Record<string, unknown>) => void) => {
    updater(storedPreferences);
  }),
}));

vi.mock("@/lib/project-registration", () => ({
  invalidateProjectCaches: vi.fn(),
}));

// ── Import route after mocks ──────────────────────────────────────────
import { PUT } from "../route";

beforeEach(() => {
  vi.clearAllMocks();
  storedPreferences = {};
});

describe("PUT /api/settings/preferences", () => {
  it("returns 400 for invalid body", async () => {
    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectOrder: "not-an-array" }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("updates projectOrder filtering to portfolio ids", async () => {
    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectOrder: ["proj-b", "proj-a", "unknown-id"] }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(storedPreferences.projectOrder).toEqual(["proj-b", "proj-a"]);
  });

  it("sets defaultProject when id is in the portfolio", async () => {
    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultProject: "proj-a" }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(200);
    expect(storedPreferences.defaultProjectId).toBe("proj-a");
  });

  it("clears defaultProject when id is not in the portfolio", async () => {
    storedPreferences.defaultProjectId = "proj-a";
    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultProject: "nonexistent" }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(200);
    expect(storedPreferences.defaultProjectId).toBeUndefined();
  });

  it("clears projectOrder when all ids are unknown", async () => {
    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectOrder: ["unknown-1", "unknown-2"] }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(200);
    expect(storedPreferences.projectOrder).toBeUndefined();
  });

  it("returns 500 when updatePreferences throws", async () => {
    const { updatePreferences } = await import("@aoagents/ao-core");
    (updatePreferences as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const request = new Request("http://localhost/api/settings/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectOrder: ["proj-a"] }),
    });

    const res = await PUT(request);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("disk full");
  });
});

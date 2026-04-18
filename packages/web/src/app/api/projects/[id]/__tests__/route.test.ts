import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock data ─────────────────────────────────────────────────────────
const mockPortfolio = [
  { id: "proj-a", name: "Project A", configProjectKey: "proj-a" },
  { id: "proj-b", name: "Project B" },
];

let storedPreferences: Record<string, unknown> = {};
const mockIsPortfolioEnabled = vi.fn(() => true);
const mockLoadGlobalConfig = vi.fn();
const mockSaveGlobalConfig = vi.fn();
const mockReloadServices = vi.fn();

vi.mock("@aoagents/ao-core", () => ({
  getPortfolio: vi.fn(() => mockPortfolio),
  isPortfolioEnabled: vi.fn(() => mockIsPortfolioEnabled()),
  loadPreferences: vi.fn(() => storedPreferences),
  loadGlobalConfig: vi.fn((...args: unknown[]) => mockLoadGlobalConfig(...args)),
  saveGlobalConfig: vi.fn((...args: unknown[]) => mockSaveGlobalConfig(...args)),
  updatePreferences: vi.fn((updater: (prefs: Record<string, unknown>) => void) => {
    updater(storedPreferences);
  }),
  unregisterProject: vi.fn(),
}));

vi.mock("@/lib/project-registration", () => ({
  invalidateProjectCaches: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  reloadServices: vi.fn((...args: unknown[]) => mockReloadServices(...args)),
}));

vi.mock("@/lib/api-schemas", async () => {
  const { z } = await import("zod");
  return {
    UpdateProjectPrefsSchema: z.object({
      pinned: z.boolean().optional(),
      enabled: z.boolean().optional(),
      displayName: z.string().optional(),
    }),
    UpdateProjectBehaviorSchema: z.object({
      repo: z.string().optional(),
      defaultBranch: z.string().optional(),
      runtime: z.string().optional(),
      agent: z.string().optional(),
      workspace: z.string().optional(),
      tracker: z.record(z.unknown()).optional(),
      scm: z.record(z.unknown()).optional(),
      symlinks: z.array(z.string()).optional(),
      postCreate: z.array(z.string()).optional(),
      agentConfig: z.record(z.unknown()).optional(),
      orchestrator: z.record(z.unknown()).optional(),
      worker: z.record(z.unknown()).optional(),
      reactions: z.record(z.record(z.unknown())).optional(),
      agentRules: z.string().optional(),
      agentRulesFile: z.string().optional(),
      orchestratorRules: z.string().optional(),
      orchestratorSessionStrategy: z
        .enum(["reuse", "delete", "ignore", "delete-new", "ignore-new", "kill-previous"])
        .optional(),
      opencodeIssueSessionStrategy: z.enum(["reuse", "delete", "ignore"]).optional(),
      decomposer: z.record(z.unknown()).optional(),
    }),
  };
});

// ── Import route after mocks ──────────────────────────────────────────
import { PUT, PATCH, DELETE } from "../route";
import { loadGlobalConfig, saveGlobalConfig, unregisterProject } from "@aoagents/ao-core";

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedPreferences = {};
  mockIsPortfolioEnabled.mockReturnValue(true);
  mockLoadGlobalConfig.mockReturnValue({
    projects: {
      "proj-a": { path: "/tmp/proj-a", name: "Project A", repo: "acme/proj-a" },
    },
  });
  mockReloadServices.mockResolvedValue({ config: { projects: {} } });
});

describe("PUT /api/projects/[id]", () => {
  it("returns 404 when project is not in portfolio", async () => {
    const request = new Request("http://localhost/api/projects/unknown", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    const res = await PUT(request, makeContext("unknown"));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 404 when portfolio mode is disabled", async () => {
    mockIsPortfolioEnabled.mockReturnValue(false);
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid body", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: "not-a-boolean" }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(400);
  });

  it("updates pinned preference", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.project.id).toBe("proj-a");
    expect(mockReloadServices).toHaveBeenCalled();
  });

  it("updates enabled preference", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockReloadServices).toHaveBeenCalled();
  });

  it("updates displayName preference", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "My Custom Name" }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(mockReloadServices).toHaveBeenCalled();
  });

  it("returns 500 when updatePreferences throws", async () => {
    const { updatePreferences } = await import("@aoagents/ao-core");
    (updatePreferences as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("write failed");
    });

    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: true }),
    });

    const res = await PUT(request, makeContext("proj-a"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("write failed");
  });
});

describe("DELETE /api/projects/[id]", () => {
  it("returns 404 when project is not in portfolio", async () => {
    const request = new Request("http://localhost/api/projects/unknown", {
      method: "DELETE",
    });

    const res = await DELETE(request, makeContext("unknown"));
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("returns 404 when portfolio mode is disabled", async () => {
    mockIsPortfolioEnabled.mockReturnValue(false);
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "DELETE",
    });

    const res = await DELETE(request, makeContext("proj-a"));
    expect(res.status).toBe(404);
  });

  it("deletes a project and cleans up preferences", async () => {
    storedPreferences = {
      projects: { "proj-a": { pinned: true }, "proj-b": { pinned: false } },
      projectOrder: ["proj-a", "proj-b"],
      defaultProjectId: "proj-a",
    };

    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "DELETE",
    });

    const res = await DELETE(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(unregisterProject).toHaveBeenCalledWith("proj-a");

    // Verify preferences were cleaned up
    expect(storedPreferences.defaultProjectId).toBeUndefined();
    expect(storedPreferences.projectOrder).toEqual(["proj-b"]);
    expect(
      (storedPreferences.projects as Record<string, unknown>)?.["proj-a"],
    ).toBeUndefined();
    expect(mockReloadServices).toHaveBeenCalled();
  });

  it("clears projectOrder when last project is removed", async () => {
    storedPreferences = {
      projects: { "proj-a": { pinned: true } },
      projectOrder: ["proj-a"],
    };

    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "DELETE",
    });

    const res = await DELETE(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    expect(storedPreferences.projectOrder).toBeUndefined();
    expect(storedPreferences.projects).toBeUndefined();
  });

  it("returns 500 when unregisterProject throws", async () => {
    (unregisterProject as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("unregister failed");
    });

    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "DELETE",
    });

    const res = await DELETE(request, makeContext("proj-a"));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("unregister failed");
  });
});

describe("PATCH /api/projects/[id]", () => {
  it("updates project behavior in the global config", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultBranch: "develop", agent: "codex" }),
    });

    const res = await PATCH(request, makeContext("proj-a"));
    expect(res.status).toBe(200);
    expect(loadGlobalConfig).toHaveBeenCalled();
    expect(saveGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.objectContaining({
          "proj-a": expect.objectContaining({
            path: "/tmp/proj-a",
            name: "Project A",
            repo: "acme/proj-a",
            defaultBranch: "develop",
            agent: "codex",
          }),
        }),
      }),
    );
    expect(mockReloadServices).toHaveBeenCalled();
  });

  it("rejects identity-owned fields", async () => {
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/new-path" }),
    });

    const res = await PATCH(request, makeContext("proj-a"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("identity-owned");
  });

  it("returns 404 when global config is missing", async () => {
    mockLoadGlobalConfig.mockReturnValueOnce(null);
    const request = new Request("http://localhost/api/projects/proj-a", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "codex" }),
    });

    const res = await PATCH(request, makeContext("proj-a"));
    expect(res.status).toBe(404);
  });
});

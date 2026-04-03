/**
 * Unit tests for migration.ts — buildEffectiveConfig function.
 *
 * Tests the effective config building logic including hybrid mode fallbacks,
 * empty repo warnings, notifier collision handling, and notificationRouting merge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockLoadShadowFile,
  mockDetectConfigMode,
  mockFindLocalConfigPath,
  mockLoadLocalProjectConfig,
  mockExpandHome,
  mockGenerateSessionPrefix,
  mockGenerateProjectId,
} = vi.hoisted(() => ({
  mockLoadShadowFile: vi.fn(),
  mockDetectConfigMode: vi.fn().mockReturnValue("global-only"),
  mockFindLocalConfigPath: vi.fn().mockReturnValue(null),
  mockLoadLocalProjectConfig: vi.fn(),
  mockExpandHome: vi.fn((p: string) => p),
  mockGenerateSessionPrefix: vi.fn((s: string) => s.slice(0, 2)),
  mockGenerateProjectId: vi.fn((p: string) => p.split("/").pop() ?? p),
}));

vi.mock("../global-config.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../global-config.js")>();
  return {
    ...actual,
    loadShadowFile: mockLoadShadowFile,
    detectConfigMode: mockDetectConfigMode,
    findLocalConfigPath: mockFindLocalConfigPath,
    loadLocalProjectConfig: mockLoadLocalProjectConfig,
  };
});

vi.mock("../paths.js", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../paths.js")>();
  return {
    ...actual,
    expandHome: mockExpandHome,
    generateSessionPrefix: mockGenerateSessionPrefix,
    generateProjectId: mockGenerateProjectId,
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { buildEffectiveConfig } from "../migration.js";
import type { GlobalConfig } from "../global-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: {
      ao: { name: "Agent Orchestrator", path: "/home/user/ao" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildEffectiveConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectConfigMode.mockReturnValue("global-only");
    mockFindLocalConfigPath.mockReturnValue(null);
    mockExpandHome.mockImplementation((p: string) => p);
    mockGenerateSessionPrefix.mockImplementation((s: string) => s.slice(0, 2));
    mockGenerateProjectId.mockImplementation((p: string) => p.split("/").pop() ?? p);
    mockLoadShadowFile.mockReturnValue(null);
  });

  it("builds config from global-only mode with shadow file", () => {
    mockLoadShadowFile.mockReturnValue({ repo: "org/ao", defaultBranch: "main" });

    const result = buildEffectiveConfig(makeGlobalConfig(), "/home/user/.ao/config.yaml");

    expect(result.projects["ao"]).toBeDefined();
    expect(result.projects["ao"].repo).toBe("org/ao");
    expect(result.projects["ao"].defaultBranch).toBe("main");
    expect(result.configPath).toBe("/home/user/.ao/config.yaml");
    expect(result.globalConfigPath).toBe("/home/user/.ao/config.yaml");
  });

  it("emits warn for empty repo field and still builds config", () => {
    mockLoadShadowFile.mockReturnValue({ repo: "", defaultBranch: "main" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has no "repo" field'));
    expect(result.projects["ao"]).toBeDefined();
    warnSpy.mockRestore();
  });

  it("emits warn when repo field is missing entirely", () => {
    mockLoadShadowFile.mockReturnValue({ defaultBranch: "main" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"ao"'));
    warnSpy.mockRestore();
  });

  describe("hybrid mode", () => {
    beforeEach(() => {
      mockDetectConfigMode.mockReturnValue("hybrid");
    });

    it("uses local config when found", () => {
      mockFindLocalConfigPath.mockReturnValue("/home/user/ao/agent-orchestrator.yaml");
      mockLoadLocalProjectConfig.mockReturnValue({
        repo: "org/ao-local",
        defaultBranch: "develop",
      });

      const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

      expect(result.projects["ao"].repo).toBe("org/ao-local");
      expect(result.projects["ao"].defaultBranch).toBe("develop");
    });

    it("falls back to shadow file when loadLocalProjectConfig throws (line 61)", () => {
      mockFindLocalConfigPath.mockReturnValue("/home/user/ao/agent-orchestrator.yaml");
      mockLoadLocalProjectConfig.mockImplementation(() => {
        throw new Error("Invalid YAML");
      });
      mockLoadShadowFile.mockReturnValue({ repo: "org/ao-shadow", defaultBranch: "main" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

      // Should use shadow file repo, not crash
      expect(result.projects["ao"].repo).toBe("org/ao-shadow");
      warnSpy.mockRestore();
    });

    it("falls back to shadow file when findLocalConfigPath returns null (line 64)", () => {
      // detectConfigMode returns "hybrid" but findLocalConfigPath returns null
      // (race: file deleted between detection and lookup)
      mockFindLocalConfigPath.mockReturnValue(null);
      mockLoadShadowFile.mockReturnValue({ repo: "org/ao-shadow", defaultBranch: "main" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

      expect(result.projects["ao"].repo).toBe("org/ao-shadow");
      warnSpy.mockRestore();
    });
  });

  describe("notifier merging", () => {
    it("merges notifiers from a single project", () => {
      mockLoadShadowFile.mockReturnValue({
        repo: "org/ao",
        notifiers: { slack: { type: "slack", url: "https://hooks.slack.com/foo" } },
      });

      const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

      expect(result.notifiers["slack"]).toBeDefined();
    });

    it("warns and skips duplicate notifier keys (first-registered wins)", () => {
      const config = makeGlobalConfig({
        projects: {
          p1: { name: "Project 1", path: "/home/user/p1" },
          p2: { name: "Project 2", path: "/home/user/p2" },
        },
      });

      // Both projects define the same notifier key "slack"
      mockLoadShadowFile.mockImplementation((id: string) => {
        if (id === "p1") return { repo: "org/p1", notifiers: { slack: { type: "slack", url: "url1" } } };
        if (id === "p2") return { repo: "org/p2", notifiers: { slack: { type: "slack", url: "url2" } } };
        return null;
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = buildEffectiveConfig(config, "/config.yaml");

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"slack" is already defined'));
      // First project's value should win
      expect((result.notifiers["slack"] as unknown as { url: string }).url).toBe("url1");
      warnSpy.mockRestore();
    });

    it("merges unique notifier keys from multiple projects (line 127)", () => {
      const config = makeGlobalConfig({
        projects: {
          p1: { name: "Project 1", path: "/home/user/p1" },
          p2: { name: "Project 2", path: "/home/user/p2" },
        },
      });

      mockLoadShadowFile.mockImplementation((id: string) => {
        if (id === "p1") return { repo: "org/p1", notifiers: { slack: { type: "slack", url: "url1" } } };
        if (id === "p2") return { repo: "org/p2", notifiers: { webhook: { type: "webhook", url: "url2" } } };
        return null;
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = buildEffectiveConfig(config, "/config.yaml");
      warnSpy.mockRestore();

      expect(result.notifiers["slack"]).toBeDefined();
      expect(result.notifiers["webhook"]).toBeDefined();
    });

    it("merges notificationRouting from project behavior fields (line 132)", () => {
      mockLoadShadowFile.mockReturnValue({
        repo: "org/ao",
        notificationRouting: { urgent: ["slack", "desktop"], warning: ["slack"] },
      });

      const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

      expect(result.notificationRouting["urgent"]).toContain("slack");
      expect(result.notificationRouting["urgent"]).toContain("desktop");
      expect(result.notificationRouting["warning"]).toContain("slack");
    });
  });

  it("uses projectId as name fallback when entry.name is undefined (line 90)", () => {
    mockLoadShadowFile.mockReturnValue({ repo: "org/ao" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = makeGlobalConfig({
      projects: {
        ao: { path: "/home/user/ao" } as GlobalConfig["projects"][string],
      },
    });
    const result = buildEffectiveConfig(config, "/config.yaml");

    expect(result.projects["ao"].name).toBe("ao");
    warnSpy.mockRestore();
  });

  it("returns empty object for projects with no shadow file", () => {
    mockLoadShadowFile.mockReturnValue(null);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

    // Should still build a project entry with empty/default values
    expect(result.projects["ao"]).toBeDefined();
    warnSpy.mockRestore();
  });

  it("strips _internal fields from shadow file", () => {
    mockLoadShadowFile.mockReturnValue({
      repo: "org/ao",
      _internalField: "should-be-stripped",
      defaultBranch: "main",
    });

    const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

    // _internalField should not bleed into the project config
    expect((result.projects["ao"] as unknown as Record<string, unknown>)["_internalField"]).toBeUndefined();
  });

  it("uses existing sessionPrefix from shadow instead of deriving", () => {
    mockLoadShadowFile.mockReturnValue({
      repo: "org/ao",
      sessionPrefix: "custom-prefix",
    });

    const result = buildEffectiveConfig(makeGlobalConfig(), "/config.yaml");

    expect(result.projects["ao"].sessionPrefix).toBe("custom-prefix");
    // generateSessionPrefix should NOT have been called if prefix came from shadow
    expect(mockGenerateSessionPrefix).not.toHaveBeenCalled();
  });
});

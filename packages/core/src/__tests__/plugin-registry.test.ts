import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPluginRegistry } from "../plugin-registry.js";
import type { PluginModule, PluginManifest, OrchestratorConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(slot: PluginManifest["slot"], name: string): PluginModule {
  return {
    manifest: {
      name,
      slot,
      description: `Test ${slot} plugin: ${name}`,
      version: "0.0.1",
    },
    create: vi.fn((config?: Record<string, unknown>) => ({
      name,
      _config: config,
    })),
  };
}

function makeOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {},
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: ["desktop"],
    },
    reactions: {},
    ...overrides,
  } as OrchestratorConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPluginRegistry", () => {
  it("returns a registry object", () => {
    const registry = createPluginRegistry();
    expect(registry).toHaveProperty("register");
    expect(registry).toHaveProperty("get");
    expect(registry).toHaveProperty("list");
    expect(registry).toHaveProperty("loadBuiltins");
    expect(registry).toHaveProperty("loadFromConfig");
  });
});

describe("register + get", () => {
  it("registers and retrieves a plugin", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("runtime", "tmux");

    registry.register(plugin);

    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
    expect(instance!.name).toBe("tmux");
  });

  it("returns null for unregistered plugin", () => {
    const registry = createPluginRegistry();
    expect(registry.get("runtime", "nonexistent")).toBeNull();
  });

  it("passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
    const instance = registry.get<{ _config: Record<string, unknown> }>("workspace", "worktree");
    expect(instance!._config).toEqual({ worktreeDir: "/custom/path" });
  });

  it("overwrites previously registered plugin with same slot:name", () => {
    const registry = createPluginRegistry();
    const plugin1 = makePlugin("runtime", "tmux");
    const plugin2 = makePlugin("runtime", "tmux");

    registry.register(plugin1);
    registry.register(plugin2);

    // Should call create on both
    expect(plugin1.create).toHaveBeenCalledTimes(1);
    expect(plugin2.create).toHaveBeenCalledTimes(1);

    // get() returns the latest
    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
  });

  it("registers plugins in different slots independently", () => {
    const registry = createPluginRegistry();
    const runtimePlugin = makePlugin("runtime", "tmux");
    const workspacePlugin = makePlugin("workspace", "worktree");

    registry.register(runtimePlugin);
    registry.register(workspacePlugin);

    expect(registry.get("runtime", "tmux")).not.toBeNull();
    expect(registry.get("workspace", "worktree")).not.toBeNull();
    expect(registry.get("runtime", "worktree")).toBeNull();
    expect(registry.get("workspace", "tmux")).toBeNull();
  });
});

describe("list", () => {
  it("lists plugins in a given slot", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));
    registry.register(makePlugin("runtime", "process"));
    registry.register(makePlugin("workspace", "worktree"));

    const runtimes = registry.list("runtime");
    expect(runtimes).toHaveLength(2);
    expect(runtimes.map((m) => m.name)).toContain("tmux");
    expect(runtimes.map((m) => m.name)).toContain("process");
  });

  it("returns empty array for slot with no plugins", () => {
    const registry = createPluginRegistry();
    expect(registry.list("notifier")).toEqual([]);
  });

  it("does not return plugins from other slots", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));

    expect(registry.list("workspace")).toEqual([]);
  });
});

describe("loadBuiltins", () => {
  it("silently skips unavailable packages", async () => {
    const registry = createPluginRegistry();
    // loadBuiltins tries to import all built-in packages.
    // In the test environment, most are not resolvable — should not throw.
    await expect(registry.loadBuiltins()).resolves.toBeUndefined();
  });

  it("registers multiple agent plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeClaudeCode = makePlugin("agent", "claude-code");
    const fakeCodex = makePlugin("agent", "codex");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-agent-claude-code") return fakeClaudeCode;
      if (pkg === "@composio/ao-plugin-agent-codex") return fakeCodex;
      throw new Error(`Not found: ${pkg}`);
    });

    const agents = registry.list("agent");
    expect(agents).toContainEqual(expect.objectContaining({ name: "claude-code", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "codex", slot: "agent" }));

    expect(registry.get("agent", "codex")).not.toBeNull();
    expect(registry.get("agent", "claude-code")).not.toBeNull();
  });
});

describe("extractPluginConfig (via register with config)", () => {
  // extractPluginConfig is tested indirectly: we verify that register()
  // correctly passes config through, and that loadBuiltins() would call
  // extractPluginConfig for known slot:name pairs. The actual config
  // forwarding logic is validated in workspace plugin unit tests.

  it("register passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
  });

  it("register passes undefined config when none provided", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "clone");

    registry.register(plugin);

    expect(plugin.create).toHaveBeenCalledWith(undefined);
  });
});

describe("loadFromConfig", () => {
  it("does not throw when no plugins are importable", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({});

    // loadFromConfig calls loadBuiltins internally, which may fail to
    // import packages in the test env — should still succeed gracefully
    await expect(registry.loadFromConfig(config)).resolves.toBeUndefined();
  });

  it("does not crash when defaults are missing/empty", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      defaults: {} as OrchestratorConfig["defaults"],
    });

    await expect(registry.loadFromConfig(config)).resolves.toBeUndefined();
  });

  it("does not crash when defaults contain nullish/non-string values", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      defaults: {
        runtime: null,
        agent: undefined,
        workspace: 123,
        notifiers: [null, "desktop"],
      } as unknown as OrchestratorConfig["defaults"],
    });

    await expect(registry.loadFromConfig(config)).resolves.toBeUndefined();
  });

  it("ignores non-string project plugin refs", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          runtime: 123 as unknown as string,
          agent: { bad: true } as unknown as string,
          workspace: null as unknown as string,
          tracker: { plugin: 99 as unknown as string },
          scm: { plugin: false as unknown as string },
        },
      },
    });
    const calls: string[] = [];

    await expect(
      registry.loadFromConfig(config, async (pkg: string) => {
        calls.push(pkg);
        throw new Error(`not found: ${pkg}`);
      }),
    ).resolves.toBeUndefined();

    expect(calls.some((target) => target.includes("123"))).toBe(false);
    expect(calls.some((target) => target.includes("[object Object]"))).toBe(false);
  });

  it("loads a non-builtin plugin referenced in project config", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "gitlab" },
        },
      },
    });
    const gitlabPlugin = makePlugin("scm", "gitlab");

    await registry.loadFromConfig(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-scm-gitlab") return gitlabPlugin;
      throw new Error(`not found: ${pkg}`);
    });

    expect(registry.get("scm", "gitlab")).not.toBeNull();
  });

  it("passes notifier config (including webhook alias) to notifier plugin", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: ["slack"],
      },
      notifiers: {
        slack: {
          plugin: "slack",
          webhook: "https://example.com/hook",
          channel: "#alerts",
        },
      },
    });
    const slackPlugin = makePlugin("notifier", "slack");

    await registry.loadFromConfig(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-slack") return slackPlugin;
      throw new Error(`not found: ${pkg}`);
    });

    expect(slackPlugin.create).toHaveBeenCalledWith({
      plugin: "slack",
      webhook: "https://example.com/hook",
      webhookUrl: "https://example.com/hook",
      channel: "#alerts",
    });
  });

  it("ignores non-object notifier config entries", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      notifiers: {
        slack: "slack" as unknown as OrchestratorConfig["notifiers"][string],
      },
    });
    const slackPlugin = makePlugin("notifier", "slack");

    await registry.loadFromConfig(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-slack") return slackPlugin;
      throw new Error(`not found: ${pkg}`);
    });

    expect(slackPlugin.create).toHaveBeenCalledWith(undefined);
  });

  it("passes dashboardUrl config to terminal-web plugin", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      port: 4444,
    });
    const terminalWeb = makePlugin("terminal", "web");

    await registry.loadFromConfig(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-terminal-web") return terminalWeb;
      throw new Error(`not found: ${pkg}`);
    });

    expect(terminalWeb.create).toHaveBeenCalledWith({
      dashboardUrl: "http://localhost:4444",
    });
  });

  it("resolves relative plugin paths from config directory", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      configPath: "/Users/test/project/agent-orchestrator.yaml",
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "./plugins/scm-custom/dist/index.js" },
        },
      },
    });
    const localScmPlugin = makePlugin("scm", "custom");
    const calls: string[] = [];

    await registry.loadFromConfig(config, async (pkg: string) => {
      calls.push(pkg);
      if (pkg === "file:///Users/test/project/plugins/scm-custom/dist/index.js") {
        return localScmPlugin;
      }
      throw new Error(`not found: ${pkg}`);
    });

    expect(calls).toContain("file:///Users/test/project/plugins/scm-custom/dist/index.js");
  });

  it("resolves slash-based local plugin paths from config directory", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      configPath: "/Users/test/project/agent-orchestrator.yaml",
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "plugins/scm-custom/dist/index.js" },
        },
      },
    });
    const calls: string[] = [];

    await registry.loadFromConfig(config, async (pkg: string) => {
      calls.push(pkg);
      throw new Error(`not found: ${pkg}`);
    });

    expect(calls).toContain("file:///Users/test/project/plugins/scm-custom/dist/index.js");
  });

  it("resolves relative plugin paths from cwd when configPath is missing", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      configPath: undefined as unknown as string,
      projects: {
        app: {
          name: "app",
          repo: "org/app",
          path: "/tmp/app",
          defaultBranch: "main",
          sessionPrefix: "app",
          scm: { plugin: "./plugins/scm-custom/dist/index.js" },
        },
      },
    });
    const calls: string[] = [];

    await registry.loadFromConfig(config, async (pkg: string) => {
      calls.push(pkg);
      throw new Error(`not found: ${pkg}`);
    });

    expect(calls.some((target) => target.startsWith("file://"))).toBe(true);
  });
});

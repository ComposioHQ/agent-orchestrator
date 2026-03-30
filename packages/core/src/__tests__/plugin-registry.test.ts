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
    projects: {},
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
    const fakeOpenCode = makePlugin("agent", "opencode");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-agent-claude-code") return fakeClaudeCode;
      if (pkg === "@composio/ao-plugin-agent-codex") return fakeCodex;
      if (pkg === "@composio/ao-plugin-agent-opencode") return fakeOpenCode;
      throw new Error(`Not found: ${pkg}`);
    });

    const agents = registry.list("agent");
    expect(agents).toContainEqual(expect.objectContaining({ name: "claude-code", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "codex", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "opencode", slot: "agent" }));

    expect(registry.get("agent", "codex")).not.toBeNull();
    expect(registry.get("agent", "claude-code")).not.toBeNull();
    expect(registry.get("agent", "opencode")).not.toBeNull();
  });

  it("registers gitlab tracker and scm plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeTracker = makePlugin("tracker", "gitlab");
    const fakeScm = makePlugin("scm", "gitlab");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-tracker-gitlab") return fakeTracker;
      if (pkg === "@composio/ao-plugin-scm-gitlab") return fakeScm;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(registry.list("tracker")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "tracker" }),
    );
    expect(registry.list("scm")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "scm" }),
    );
  });

  it("passes configured notifier plugin config to create()", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        webhook: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 2,
          retryDelayMs: 500,
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 2,
      retryDelayMs: 500,
    });
  });

  it("matches notifier config by plugin name instead of instance key", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        "my-webhook": {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/custom-hook",
          retries: 4,
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/custom-hook",
      retries: 4,
    });
  });

  it("passes notifier config from config.notifiers when loading builtins", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          url: "http://127.0.0.1:18789/hooks/agent",
          token: "tok",
        },
      },
    });

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-openclaw") return fakeOpenClaw;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeOpenClaw.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18789/hooks/agent",
      token: "tok",
    });
  });

  it("does not match notifier key when explicit plugin points to another notifier", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const fakeWebhook = makePlugin("notifier", "webhook");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 3,
        },
      },
    });

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@composio/ao-plugin-notifier-openclaw") return fakeOpenClaw;
      if (pkg === "@composio/ao-plugin-notifier-webhook") return fakeWebhook;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeOpenClaw.create).toHaveBeenCalledWith(undefined);
    expect(fakeWebhook.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 3,
    });
  });

  it("should use provided importFn instead of built-in import", async () => {
    const registry = createPluginRegistry();
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      // Return a valid plugin module for runtime-tmux
      if (pkg === "@composio/ao-plugin-runtime-tmux") {
        return {
          manifest: { name: "tmux", slot: "runtime", description: "test", version: "0.0.0" },
          create: () => ({ name: "tmux" }),
        };
      }
      // Throw for everything else to simulate not-installed
      throw new Error(`Module not found: ${pkg}`);
    };

    await registry.loadBuiltins(undefined, fakeImportFn);

    // importFn should have been called for all builtin plugins
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@composio/ao-plugin-runtime-tmux");

    // The tmux plugin should be registered
    const tmux = registry.get("runtime", "tmux");
    expect(tmux).not.toBeNull();
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

  it("should pass importFn through loadFromConfig to loadBuiltins", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({});
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      throw new Error(`Not found: ${pkg}`);
    };

    await registry.loadFromConfig(config, fakeImportFn);

    // Should have attempted to import builtin plugins via the provided importFn
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@composio/ao-plugin-runtime-tmux");
  });
});

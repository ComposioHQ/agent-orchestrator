/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@composio/ao-plugin-*)
 * 3. Local file paths specified in config
 */

import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
  NotifierConfig,
} from "./types.js";
import { dirname, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;
type PluginRef = { slot: PluginSlot; name: string };
type DefaultsShape = Partial<{
  runtime: unknown;
  agent: unknown;
  workspace: unknown;
  notifiers: unknown;
}>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

function isPluginModule(mod: unknown): mod is PluginModule {
  if (!mod || typeof mod !== "object") return false;
  const candidate = mod as Partial<PluginModule>;
  return Boolean(candidate.manifest && typeof candidate.create === "function");
}

function normalizeImportedModule(mod: unknown): PluginModule | null {
  if (isPluginModule(mod)) return mod;
  if (mod && typeof mod === "object" && "default" in mod) {
    const fromDefault = (mod as { default?: unknown }).default;
    if (isPluginModule(fromDefault)) return fromDefault;
  }
  return null;
}

function configForNotifier(name: string, config: OrchestratorConfig): Record<string, unknown> | undefined {
  const notifiers = config.notifiers ?? {};
  const direct = notifiers[name];
  const byPlugin = Object.values(notifiers).find(
    (notifierConfig: NotifierConfig) => notifierConfig.plugin === name,
  );
  const selected = direct ?? byPlugin;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return undefined;

  const normalized = { ...selected } as Record<string, unknown>;
  if (typeof normalized["webhook"] === "string" && normalized["webhookUrl"] === undefined) {
    normalized["webhookUrl"] = normalized["webhook"];
  }

  return normalized;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@composio/ao-plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@composio/ao-plugin-runtime-process" },
  { slot: "runtime", name: "docker", pkg: "@composio/ao-plugin-runtime-docker" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@composio/ao-plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@composio/ao-plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@composio/ao-plugin-agent-aider" },
  { slot: "agent", name: "gemini", pkg: "@composio/ao-plugin-agent-gemini" },
  { slot: "agent", name: "goose", pkg: "@composio/ao-plugin-agent-goose" },
  { slot: "agent", name: "amazon-q", pkg: "@composio/ao-plugin-agent-amazon-q" },
  { slot: "agent", name: "kiro", pkg: "@composio/ao-plugin-agent-kiro" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@composio/ao-plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@composio/ao-plugin-workspace-clone" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@composio/ao-plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@composio/ao-plugin-tracker-linear" },
  { slot: "tracker", name: "jira", pkg: "@composio/ao-plugin-tracker-jira" },
  // SCM
  { slot: "scm", name: "github", pkg: "@composio/ao-plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@composio/ao-plugin-scm-gitlab" },
  // Notifiers
  { slot: "notifier", name: "composio", pkg: "@composio/ao-plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@composio/ao-plugin-notifier-desktop" },
  { slot: "notifier", name: "slack", pkg: "@composio/ao-plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@composio/ao-plugin-notifier-webhook" },
  { slot: "notifier", name: "discord", pkg: "@composio/ao-plugin-notifier-discord" },
  { slot: "notifier", name: "email", pkg: "@composio/ao-plugin-notifier-email" },
  { slot: "notifier", name: "teams", pkg: "@composio/ao-plugin-notifier-teams" },
  { slot: "notifier", name: "telegram", pkg: "@composio/ao-plugin-notifier-telegram" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@composio/ao-plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@composio/ao-plugin-terminal-web" },
  { slot: "terminal", name: "kitty", pkg: "@composio/ao-plugin-terminal-kitty" },
  { slot: "terminal", name: "wezterm", pkg: "@composio/ao-plugin-terminal-wezterm" },
  { slot: "terminal", name: "zellij", pkg: "@composio/ao-plugin-terminal-zellij" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  if (slot === "notifier") {
    return configForNotifier(name, config);
  }

  if (slot === "terminal" && name === "web") {
    return {
      dashboardUrl: `http://localhost:${config.port ?? 3000}`,
    };
  }

  return undefined;
}

function collectConfiguredPluginRefs(config: OrchestratorConfig): PluginRef[] {
  const refs: PluginRef[] = [];
  const defaults: DefaultsShape = (config.defaults ?? {
    runtime: "tmux",
    agent: "claude-code",
    workspace: "worktree",
    notifiers: ["composio", "desktop"],
  }) as DefaultsShape;
  const defaultRuntime = typeof defaults.runtime === "string" ? defaults.runtime : undefined;
  const defaultAgent = typeof defaults.agent === "string" ? defaults.agent : undefined;
  const defaultWorkspace = typeof defaults.workspace === "string" ? defaults.workspace : undefined;
  const defaultNotifiers = Array.isArray(defaults.notifiers)
    ? defaults.notifiers.filter((name): name is string => typeof name === "string")
    : [];
  const projects = config.projects ?? {};
  const notifiers = config.notifiers ?? {};

  if (defaultRuntime) refs.push({ slot: "runtime", name: defaultRuntime });
  if (defaultAgent) refs.push({ slot: "agent", name: defaultAgent });
  if (defaultWorkspace) refs.push({ slot: "workspace", name: defaultWorkspace });

  for (const notifierName of defaultNotifiers) {
    refs.push({ slot: "notifier", name: notifierName });
  }

  for (const project of Object.values(projects)) {
    if (typeof project.runtime === "string") refs.push({ slot: "runtime", name: project.runtime });
    if (typeof project.agent === "string") refs.push({ slot: "agent", name: project.agent });
    if (typeof project.workspace === "string") refs.push({ slot: "workspace", name: project.workspace });
    if (typeof project.tracker?.plugin === "string") refs.push({ slot: "tracker", name: project.tracker.plugin });
    if (typeof project.scm?.plugin === "string") refs.push({ slot: "scm", name: project.scm.plugin });
  }

  for (const [notifierName, notifierConfig] of Object.entries(notifiers)) {
    const configuredName =
      typeof notifierConfig.plugin === "string" ? notifierConfig.plugin : notifierName;
    refs.push({ slot: "notifier", name: configuredName });
  }

  const unique = new Map<string, PluginRef>();
  for (const ref of refs) {
    unique.set(makeKey(ref.slot, ref.name), ref);
  }
  return [...unique.values()];
}

function resolveImportTarget(slot: PluginSlot, name: string, configPath?: string): string {
  const isRelativePathLike = name.startsWith(".") || (!name.startsWith("@") && /[\\/]/.test(name));
  const isFileUrl = name.startsWith("file://");

  if (isFileUrl) return name;
  if (name.startsWith("@")) return name;

  if (isRelativePathLike) {
    const baseDir = configPath ? dirname(configPath) : process.cwd();
    const absolute = resolve(baseDir, name);
    return pathToFileURL(absolute).href;
  }

  if (isAbsolute(name)) {
    return pathToFileURL(name).href;
  }

  return `@composio/ao-plugin-${slot}-${name}`;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins: PluginMap = new Map();

  return {
    register(plugin: PluginModule, config?: Record<string, unknown>): void {
      const { manifest } = plugin;
      const key = makeKey(manifest.slot, manifest.name);
      const instance = plugin.create(config);
      plugins.set(key, { manifest, instance });
    },

    get<T>(slot: PluginSlot, name: string): T | null {
      const entry = plugins.get(makeKey(slot, name));
      return entry ? (entry.instance as T) : null;
    },

    list(slot: PluginSlot): PluginManifest[] {
      const result: PluginManifest[] = [];
      for (const [key, entry] of plugins) {
        if (key.startsWith(`${slot}:`)) {
          result.push(entry.manifest);
        }
      }
      return result;
    },

    async loadBuiltins(
      orchestratorConfig?: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = normalizeImportedModule(await doImport(builtin.pkg));
          if (mod) {
            const pluginConfig = orchestratorConfig
              ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
              : undefined;
            this.register(mod, pluginConfig);
          }
        } catch {
          // Plugin not installed — that's fine, only load what's available
        }
      }
    },

    async loadFromConfig(
      config: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      // Load built-ins with orchestrator config so plugins receive their settings
      await this.loadBuiltins(config, importFn);

      // Then, load additional plugins referenced in config that are not built-ins.
      // Supports:
      // 1) bare names ("gitlab") -> @composio/ao-plugin-scm-gitlab
      // 2) package names ("@org/ao-plugin-scm-gitlab")
      // 3) local paths ("./plugins/scm-gitlab")
      const doImport = importFn ?? ((pkg: string) => import(pkg));
      const refs = collectConfiguredPluginRefs(config);

      for (const ref of refs) {
        if (this.get(ref.slot, ref.name)) continue;
        const target = resolveImportTarget(ref.slot, ref.name, config.configPath);
        try {
          const mod = normalizeImportedModule(await doImport(target));
          if (!mod) continue;
          const pluginConfig = extractPluginConfig(ref.slot, ref.name, config);
          this.register(mod, pluginConfig);
        } catch {
          // Plugin import failed — keep going so one missing plugin doesn't block startup.
        }
      }
    },
  };
}

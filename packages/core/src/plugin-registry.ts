/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@composio/ao-plugin-*)
 * 3. Local file paths specified in config
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  InstalledPluginConfig,
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
} from "./types.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

const LOCAL_PLUGIN_ENTRY_CANDIDATES = ["dist/index.js", "index.js"] as const;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@composio/ao-plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@composio/ao-plugin-runtime-process" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@composio/ao-plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@composio/ao-plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@composio/ao-plugin-agent-aider" },
  { slot: "agent", name: "opencode", pkg: "@composio/ao-plugin-agent-opencode" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@composio/ao-plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@composio/ao-plugin-workspace-clone" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@composio/ao-plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@composio/ao-plugin-tracker-linear" },
  { slot: "tracker", name: "gitlab", pkg: "@composio/ao-plugin-tracker-gitlab" },
  // SCM
  { slot: "scm", name: "github", pkg: "@composio/ao-plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@composio/ao-plugin-scm-gitlab" },
  // Notifiers
  { slot: "notifier", name: "composio", pkg: "@composio/ao-plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@composio/ao-plugin-notifier-desktop" },
  { slot: "notifier", name: "discord", pkg: "@composio/ao-plugin-notifier-discord" },
  { slot: "notifier", name: "openclaw", pkg: "@composio/ao-plugin-notifier-openclaw" },
  { slot: "notifier", name: "slack", pkg: "@composio/ao-plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@composio/ao-plugin-notifier-webhook" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@composio/ao-plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@composio/ao-plugin-terminal-web" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // Notifiers are configured under config.notifiers.<id>.
  // Match by key (e.g. "openclaw") or explicit plugin field.
  if (slot === "notifier") {
    for (const [notifierName, notifierConfig] of Object.entries(config.notifiers ?? {})) {
      if (!notifierConfig || typeof notifierConfig !== "object") continue;
      const configuredPlugin = (notifierConfig as Record<string, unknown>)["plugin"];
      const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
      const matches = hasExplicitPlugin ? configuredPlugin === name : notifierName === name;
      if (matches) {
        const { plugin: _plugin, ...rest } = notifierConfig as Record<string, unknown>;
        return config.configPath ? { ...rest, configPath: config.configPath } : rest;
      }
    }
  }

  return undefined;
}

export function isPluginModule(value: unknown): value is PluginModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PluginModule>;
  return Boolean(candidate.manifest && typeof candidate.create === "function");
}

export function normalizeImportedPluginModule(value: unknown): PluginModule | null {
  if (isPluginModule(value)) return value;

  if (value && typeof value === "object" && "default" in value) {
    const defaultExport = (value as { default?: unknown }).default;
    if (isPluginModule(defaultExport)) return defaultExport;
  }

  return null;
}

function resolveConfigRelativePath(targetPath: string, configPath?: string): string {
  if (isAbsolute(targetPath)) return targetPath;
  const baseDir = configPath ? dirname(configPath) : process.cwd();
  return resolve(baseDir, targetPath);
}

export function resolvePackageExportsEntry(exportsField: unknown): string | null {
  if (typeof exportsField === "string") return exportsField;
  if (!exportsField || typeof exportsField !== "object") return null;

  const exportsRecord = exportsField as Record<string, unknown>;
  const dotEntry = exportsRecord["."];

  if (typeof dotEntry === "string") return dotEntry;
  if (dotEntry && typeof dotEntry === "object") {
    const importEntry = (dotEntry as Record<string, unknown>)["import"];
    if (typeof importEntry === "string") return importEntry;
    const defaultEntry = (dotEntry as Record<string, unknown>)["default"];
    if (typeof defaultEntry === "string") return defaultEntry;
  }

  const importEntry = exportsRecord["import"];
  if (typeof importEntry === "string") return importEntry;

  const defaultEntry = exportsRecord["default"];
  if (typeof defaultEntry === "string") return defaultEntry;

  return null;
}

export function resolveLocalPluginEntrypoint(pluginPath: string): string | null {
  if (!existsSync(pluginPath)) return null;

  let stat;
  try {
    stat = statSync(pluginPath);
  } catch {
    return null;
  }

  if (stat.isFile()) return pluginPath;
  if (!stat.isDirectory()) return null;

  const packageJsonPath = join(pluginPath, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const raw = readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(raw) as {
        exports?: unknown;
        module?: unknown;
        main?: unknown;
      };

      const exportsEntry = resolvePackageExportsEntry(packageJson.exports);
      if (exportsEntry) {
        const resolvedEntry = resolve(pluginPath, exportsEntry);
        if (existsSync(resolvedEntry)) return resolvedEntry;
      }

      if (typeof packageJson.module === "string") {
        const moduleEntry = resolve(pluginPath, packageJson.module);
        if (existsSync(moduleEntry)) return moduleEntry;
      }

      if (typeof packageJson.main === "string") {
        const mainEntry = resolve(pluginPath, packageJson.main);
        if (existsSync(mainEntry)) return mainEntry;
      }
    } catch {
      // Fall through to common entrypoint guesses below.
    }
  }

  for (const candidate of LOCAL_PLUGIN_ENTRY_CANDIDATES) {
    const entry = join(pluginPath, candidate);
    if (existsSync(entry)) return entry;
  }

  return null;
}

function inferPackageSpecifier(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(".") || value.startsWith("/")) return null;
  return value.startsWith("@") || value.includes("/") ? value : null;
}

function resolvePluginSpecifier(
  plugin: InstalledPluginConfig,
  config: OrchestratorConfig,
): string | null {
  switch (plugin.source) {
    case "local": {
      if (!plugin.path) return null;
      const absolutePath = resolveConfigRelativePath(plugin.path, config.configPath);
      const entrypoint = resolveLocalPluginEntrypoint(absolutePath);
      return entrypoint ? pathToFileURL(entrypoint).href : null;
    }
    case "registry":
    case "npm":
      return plugin.package ?? inferPackageSpecifier(plugin.name);
    default:
      return null;
  }
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
          const mod = normalizeImportedPluginModule(await doImport(builtin.pkg));
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

      const doImport = importFn ?? ((pkg: string) => import(pkg));

      for (const plugin of config.plugins ?? []) {
        if (plugin.enabled === false) continue;

        const specifier = resolvePluginSpecifier(plugin, config);
        if (!specifier) {
          console.warn(`[plugin-registry] Could not resolve specifier for plugin "${plugin.name}" (source: ${plugin.source})`);
          continue;
        }

        try {
          const mod = normalizeImportedPluginModule(await doImport(specifier));
          if (!mod) continue;

          const pluginConfig = extractPluginConfig(mod.manifest.slot, mod.manifest.name, config);
          this.register(mod, pluginConfig);
        } catch (error) {
          console.warn(`[plugin-registry] Failed to load plugin "${specifier}":`, error);
        }
      }
    },
  };
}

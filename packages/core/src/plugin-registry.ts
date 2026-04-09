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
  ExternalPluginEntryRef,
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
  { slot: "agent", name: "gemini", pkg: "@composio/ao-plugin-agent-gemini" },
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

function extractPluginConfig(
  slot: PluginSlot,
  name: string,
  config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // 1. Handle Notifier Slot
  if (slot === "notifier") {
    for (const [notifierId, notifierConfig] of Object.entries(config.notifiers ?? {})) {
      if (!notifierConfig || typeof notifierConfig !== "object") continue;
      const configuredPlugin = (notifierConfig as Record<string, unknown>)["plugin"];
      const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
      const matches = hasExplicitPlugin ? configuredPlugin === name : notifierId === name;

      if (matches) {
        return prepareConfig(slot, name, notifierId, notifierConfig, config.configPath);
      }
    }
  }

  // 2. Handle Tracker and SCM Slots (Project-level)
  // Tracker and SCM plugins are typically stateless singletons that receive
  // project-specific config per-call (via ProjectConfig argument), not at create() time.
  // This applies to BOTH built-in and external plugins to avoid order-dependent
  // behavior when multiple projects share the same plugin but have different configs.
  // Return undefined so plugins are initialized without project-specific config.
  if (slot === "tracker" || slot === "scm") {
    return undefined;
  }

  return undefined;
}

/**
 * Internal helper to validate and strip loading metadata from a plugin configuration.
 * Reserved fields (plugin, package, path) are used for plugin resolution and stripped.
 */
function prepareConfig(
  slot: string,
  name: string,
  sourceId: string,
  rawConfig: Record<string, unknown>,
  configPath?: string,
): Record<string, unknown> {
  // Explicitly check for reserved fields to prevent silent stripping/collision.
  // 'path' is reserved for local resolution; 'package' is reserved for npm resolution.
  if ("package" in rawConfig && "path" in rawConfig) {
    throw new Error(
      `In ${slot} "${sourceId}": both "package" and "path" are specified. ` +
        `Use "package" for npm plugins or "path" for local plugins, not both.`,
    );
  }

  // If loading via built-in name or npm package, having a 'path' field is ambiguous:
  // it could be a local plugin path (for loading) or a plugin config value.
  // We reject this to avoid silently stripping a config value the user intended to pass.
  const isBuiltin = BUILTIN_PLUGINS.some((b) => b.slot === slot && b.name === name);
  if ((rawConfig.package || isBuiltin) && "path" in rawConfig) {
    const loadingMethod = rawConfig.package ? `npm package "${rawConfig.package}"` : `built-in plugin "${name}"`;
    throw new Error(
      `In ${slot} "${sourceId}": "path" field conflicts with reserved plugin loading field. ` +
        `You're loading via ${loadingMethod}, but also have a "path" field which would be stripped. ` +
        `Rename your configuration field to something else (e.g., "apiPath", "webhookPath").`,
    );
  }

  // Strip loading metadata fields (plugin, package, path) from config passed to plugin.
  const { plugin: _plugin, package: _package, path: _path, ...rest } = rawConfig;
  return configPath ? { ...rest, configPath } : rest;
}

/**
 * Build an index of external plugin entries by package/path for O(1) lookups.
 * Multiple entries can share the same package/path (e.g., multiple projects using same plugin).
 */
function buildExternalPluginIndex(
  externalEntries: ExternalPluginEntryRef[] | undefined,
): Map<string, ExternalPluginEntryRef[]> {
  const index = new Map<string, ExternalPluginEntryRef[]>();
  if (!externalEntries) return index;

  for (const entry of externalEntries) {
    const key = entry.package ? `package:${entry.package}` : `path:${entry.path}`;
    const existing = index.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      index.set(key, [entry]);
    }
  }

  return index;
}

/**
 * Find ALL external plugin entries that match a given plugin config.
 * Used for manifest.name validation when loading inline tracker/scm/notifier plugins.
 *
 * Returns all matching entries because multiple projects may share the same
 * external plugin (same package/path), and all their configs need to be updated
 * with the actual manifest.name.
 */
function findAllExternalPluginEntries(
  plugin: InstalledPluginConfig,
  externalIndex: Map<string, ExternalPluginEntryRef[]>,
): ExternalPluginEntryRef[] {
  if (plugin.package) {
    return externalIndex.get(`package:${plugin.package}`) ?? [];
  }
  if (plugin.path) {
    return externalIndex.get(`path:${plugin.path}`) ?? [];
  }
  return [];
}

/**
 * Validate that a plugin's manifest.name matches the expected name (if specified).
 * Throws an error if there's a mismatch.
 */
function validateManifestName(
  manifest: PluginManifest,
  entry: ExternalPluginEntryRef,
  specifier: string,
): void {
  // If the user specified an explicit plugin name, validate it matches the manifest
  if (entry.expectedPluginName && entry.expectedPluginName !== manifest.name) {
    const specifierType = entry.package ? "package" : "path";
    throw new Error(
      `Plugin manifest.name mismatch at ${entry.source}: ` +
        `expected "${entry.expectedPluginName}" but ${specifierType} "${specifier}" has manifest.name "${manifest.name}". ` +
        `Either update the 'plugin' field to match the actual manifest.name, or remove it to auto-infer.`,
    );
  }
}

/**
 * Update the config with the actual plugin name after loading an external plugin.
 * This ensures resolvePlugins() can look up the plugin by its manifest.name.
 *
 * Uses structured location data to avoid ambiguity from parsing dotted strings
 * (project/notifier keys can legally contain dots).
 */
function updateConfigWithManifestName(
  manifest: PluginManifest,
  entry: ExternalPluginEntryRef,
  config: OrchestratorConfig,
): void {
  const { location, slot, source } = entry;

  // Use structured location to update the config
  if (location.kind === "project") {
    const { projectId, configType } = location;
    const project = config.projects[projectId];
    if (project?.[configType]) {
      project[configType]!.plugin = manifest.name;
    }
  } else if (location.kind === "notifier") {
    const { notifierId } = location;
    const notifierConfig = config.notifiers[notifierId];
    if (notifierConfig) {
      notifierConfig.plugin = manifest.name;
    }
  }

  // Also validate slot matches
  if (manifest.slot !== slot) {
    process.stderr.write(
      `[plugin-registry] Plugin at ${source} has slot "${manifest.slot}" but was configured as "${slot}". ` +
        `The plugin will be registered under its declared slot "${manifest.slot}".\n`,
    );
  }
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
        let mod;
        try {
          mod = normalizeImportedPluginModule(await doImport(builtin.pkg));
        } catch {
          // Plugin not installed — that's fine, only load what's available
          continue;
        }

        if (mod) {
          try {
            const pluginConfig = orchestratorConfig
              ? extractPluginConfig(builtin.slot, builtin.name, orchestratorConfig)
              : undefined;
            this.register(mod, pluginConfig);
          } catch (error) {
            process.stderr.write(
              `[plugin-registry] Failed to load built-in plugin "${builtin.name}": ${error}\n`,
            );
          }
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
      // Build index once for O(1) lookups when matching plugins to external entries
      const externalIndex = buildExternalPluginIndex(config._externalPluginEntries);

      for (const plugin of config.plugins ?? []) {
        if (plugin.enabled === false) continue;

        const specifier = resolvePluginSpecifier(plugin, config);
        if (!specifier) {
          process.stderr.write(`[plugin-registry] Could not resolve specifier for plugin "${plugin.name}" (source: ${plugin.source})\n`);
          continue;
        }

        try {
          const mod = normalizeImportedPluginModule(await doImport(specifier));
          if (!mod) continue;

          // Check if this plugin was auto-added from inline tracker/scm/notifier config.
          // Multiple projects may share the same external plugin, so find ALL matching entries.
          // We validate and update configs FIRST, before extracting plugin config, because
          // extractPluginConfig looks up by manifest.name which may differ from the temp name.
          const matchingEntries = findAllExternalPluginEntries(plugin, externalIndex);
          for (const externalEntry of matchingEntries) {
            try {
              // Validate manifest.name matches expectedPluginName (if specified)
              validateManifestName(mod.manifest, externalEntry, specifier);
              // Update the config with the actual manifest.name
              updateConfigWithManifestName(mod.manifest, externalEntry, config);
            } catch (validationError) {
              // Log validation errors but don't abort - other projects can still use the plugin.
              // The misconfigured project will fail later when it tries to use the plugin
              // with the wrong name, giving a clearer error at point of use.
              process.stderr.write(
                `[plugin-registry] Config validation failed for ${externalEntry.source}: ${validationError}\n`,
              );
            }
          }

          // Extract plugin config AFTER updating configs with manifest.name.
          // This ensures extractPluginConfig can find the config by manifest.name
          // (e.g., manifest "ms-teams" after config was updated from temp "teams").
          const pluginConfig = extractPluginConfig(mod.manifest.slot, mod.manifest.name, config);
          this.register(mod, pluginConfig);
        } catch (error) {
          process.stderr.write(`[plugin-registry] Failed to load plugin "${specifier}": ${error}\n`);
        }
      }
    },
  };
}

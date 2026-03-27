/**
 * Plugin Registry — discovers and loads plugins.
 *
 * Plugins can be:
 * 1. Built-in (packages/plugins/*)
 * 2. npm packages (@composio/ao-plugin-*)
 * 3. Local file paths specified in config
 */

import { resolve, dirname } from "node:path";
import type {
  PluginSlot,
  PluginManifest,
  PluginModule,
  PluginRegistry,
  OrchestratorConfig,
  TrackerConfig,
  SCMConfig,
  NotifierConfig,
} from "./types.js";
import { expandHome } from "./paths.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

async function importModule(specifier: string): Promise<unknown> {
  return import(/* webpackIgnore: true */ specifier);
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

// =============================================================================
// Shared plugin-metadata stripping
// =============================================================================

/** Keys that are plugin infrastructure metadata, not plugin-specific configuration */
const PLUGIN_META_KEYS = new Set(["plugin", "package", "path"]);

function stripPluginMeta(cfg: Record<string, unknown>): Record<string, unknown> | undefined {
  const rest: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [k, v] of Object.entries(cfg)) {
    if (!PLUGIN_META_KEYS.has(k)) {
      rest[k] = v;
      hasKeys = true;
    }
  }
  return hasKeys ? rest : undefined;
}

// =============================================================================
// External plugin declaration collection
// =============================================================================

/** A normalized external plugin declaration collected from config */
interface ExternalPluginDeclaration {
  slot: PluginSlot;
  name: string;
  sourceType: "package" | "path";
  sourceValue: string;
  config?: Record<string, unknown>;
}

/** Check whether a plugin config object declares an external source */
function hasExternalSource(cfg: { package?: string; path?: string }): boolean {
  return !!cfg.package || !!cfg.path;
}

/**
 * Scan orchestrator config and collect all external plugin declarations.
 * Deduplicates by slot:name. Rejects conflicting sources for the same slot:name.
 *
 * For per-project slots (tracker, scm): no create() config is extracted because
 * per-project settings are passed through method parameters (e.g. `project: ProjectConfig`).
 * For top-level slots (notifier): config is extracted and passed to create().
 */
function collectExternalDeclarations(config: OrchestratorConfig): ExternalPluginDeclaration[] {
  const seen = new Map<string, { sourceType: string; sourceValue: string; projectId?: string }>();
  const declarations: ExternalPluginDeclaration[] = [];

  function add(
    slot: PluginSlot,
    name: string,
    source: { package?: string; path?: string },
    pluginConfig?: Record<string, unknown>,
    projectId?: string,
  ): void {
    const key = `${slot}:${name}`;
    const sourceType: "package" | "path" = source.package ? "package" : "path";
    const sourceValue = source.package || source.path!;

    const existing = seen.get(key);
    if (existing) {
      // Same slot:name from a different project — ensure source matches
      if (existing.sourceType !== sourceType || existing.sourceValue !== sourceValue) {
        const ctx = projectId ? ` (project "${projectId}")` : "";
        const prevCtx = existing.projectId ? ` (project "${existing.projectId}")` : "";
        throw new Error(
          `Conflicting sources for ${slot} plugin "${name}": ` +
            `${existing.sourceType} "${existing.sourceValue}"${prevCtx} vs ` +
            `${sourceType} "${sourceValue}"${ctx}. ` +
            `All projects using the same external plugin must reference the same source.`,
        );
      }
      return;
    }

    seen.set(key, { sourceType, sourceValue, projectId });
    declarations.push({
      slot,
      name,
      sourceType,
      sourceValue,
      config: pluginConfig,
    });
  }

  function extractNotifierConfig(
    cfg: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    return stripPluginMeta(cfg);
  }

  // Collect from project tracker/scm configs.
  // No create() config — per-project settings flow through method params.
  for (const [projectId, project] of Object.entries(config.projects)) {
    const tracker = project.tracker as (TrackerConfig & Record<string, unknown>) | undefined;
    if (tracker && hasExternalSource(tracker)) {
      add("tracker", tracker.plugin, tracker, undefined, projectId);
    }

    const scm = project.scm as (SCMConfig & Record<string, unknown>) | undefined;
    if (scm && hasExternalSource(scm)) {
      add("scm", scm.plugin, scm, undefined, projectId);
    }
  }

  // Collect from top-level notifier configs.
  // Notifiers are singletons — extract create() config from the declaration.
  for (const notifierConfig of Object.values(config.notifiers ?? {})) {
    const nc = notifierConfig as NotifierConfig & Record<string, unknown>;
    if (nc && hasExternalSource(nc)) {
      add("notifier", nc.plugin, nc, extractNotifierConfig(nc));
    }
  }

  return declarations;
}

/**
 * Resolve the import source for an external plugin declaration.
 * - package: used as-is (npm package name)
 * - path: resolved relative to the config file directory
 */
function resolveImportSource(decl: ExternalPluginDeclaration, configPath: string): string {
  if (decl.sourceType === "package") {
    return decl.sourceValue;
  }
  const expanded = expandHome(decl.sourceValue);
  // Absolute paths (including expanded ~/) are used as-is;
  // relative paths are resolved against the config file directory.
  if (expanded.startsWith("/")) {
    return expanded;
  }
  const configDir = dirname(configPath);
  return resolve(configDir, expanded);
}

/** Validate that a loaded module's manifest matches the expected slot and name */
function validateManifestMatch(
  mod: PluginModule,
  expectedSlot: PluginSlot,
  expectedName: string,
  source: string,
): void {
  if (mod.manifest.slot !== expectedSlot) {
    throw new Error(
      `Plugin manifest mismatch: expected slot "${expectedSlot}" but "${source}" declares slot "${mod.manifest.slot}"`,
    );
  }
  if (mod.manifest.name !== expectedName) {
    throw new Error(
      `Plugin manifest mismatch: expected name "${expectedName}" but "${source}" declares name "${mod.manifest.name}"`,
    );
  }
}

// =============================================================================
// Built-in plugin config extraction
// =============================================================================

/** Extract plugin-specific config from orchestrator config for builtins */
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
      const nc = notifierConfig as Record<string, unknown>;
      const configuredPlugin = nc["plugin"];
      const hasExplicitPlugin = typeof configuredPlugin === "string" && configuredPlugin.length > 0;
      const matches = hasExplicitPlugin ? configuredPlugin === name : notifierName === name;
      if (matches) {
        // Entry declares an external source — config is for the external plugin, not this builtin
        if (nc["package"] || nc["path"]) continue;
        return stripPluginMeta(nc);
      }
    }
  }

  return undefined;
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
      const doImport = importFn ?? importModule;
      for (const builtin of BUILTIN_PLUGINS) {
        try {
          const mod = (await doImport(builtin.pkg)) as PluginModule;
          if (mod.manifest && typeof mod.create === "function") {
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

      // Then load any external plugins declared via package/path in config
      await this.loadExternals(config, importFn);
    },

    async loadExternals(
      config: OrchestratorConfig,
      importFn?: (pkg: string) => Promise<unknown>,
    ): Promise<void> {
      const declarations = collectExternalDeclarations(config);
      if (declarations.length === 0) return;

      const doImport = importFn ?? importModule;

      for (const decl of declarations) {
        const key = makeKey(decl.slot, decl.name);

        // Reject if a builtin already occupies this slot:name
        if (plugins.has(key)) {
          const existing = plugins.get(key)!;
          throw new Error(
            `External plugin "${decl.sourceValue}" conflicts with already-registered ` +
              `${decl.slot} plugin "${existing.manifest.name}". ` +
              `Remove the package/path field to use the built-in, or use a different plugin name.`,
          );
        }

        const source = resolveImportSource(decl, config.configPath);

        let mod: PluginModule;
        try {
          mod = (await doImport(source)) as PluginModule;
        } catch (err) {
          const kind = decl.sourceType === "package" ? "npm package" : "local path";
          throw new Error(
            `Failed to load external ${decl.slot} plugin "${decl.name}" from ${kind} "${source}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            { cause: err },
          );
        }

        if (!mod.manifest || typeof mod.create !== "function") {
          throw new Error(
            `External plugin "${source}" does not export a valid PluginModule ` +
              `(must have manifest and create). See CONTRIBUTING.md for the plugin interface.`,
          );
        }

        validateManifestMatch(mod, decl.slot, decl.name, source);
        this.register(mod, decl.config);
      }
    },
  };
}

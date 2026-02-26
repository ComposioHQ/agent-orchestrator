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
} from "./types.js";

/** Map from "slot:name" → plugin instance */
type PluginMap = Map<string, { manifest: PluginManifest; instance: unknown }>;

function makeKey(slot: PluginSlot, name: string): string {
  return `${slot}:${name}`;
}

/** Built-in plugin package names, mapped to their npm package */
const BUILTIN_PLUGINS: Array<{ slot: PluginSlot; name: string; pkg: string }> = [
  // Runtimes
  { slot: "runtime", name: "tmux", pkg: "@composio/ao-plugin-runtime-tmux" },
  { slot: "runtime", name: "process", pkg: "@composio/ao-plugin-runtime-process" },
  { slot: "runtime", name: "docker", pkg: "@composio/ao-plugin-runtime-docker" },
  { slot: "runtime", name: "e2b", pkg: "@composio/ao-plugin-runtime-e2b" },
  { slot: "runtime", name: "daytona", pkg: "@composio/ao-plugin-runtime-daytona" },
  { slot: "runtime", name: "modal", pkg: "@composio/ao-plugin-runtime-modal" },
  // Agents
  { slot: "agent", name: "claude-code", pkg: "@composio/ao-plugin-agent-claude-code" },
  { slot: "agent", name: "codex", pkg: "@composio/ao-plugin-agent-codex" },
  { slot: "agent", name: "aider", pkg: "@composio/ao-plugin-agent-aider" },
  { slot: "agent", name: "opencode", pkg: "@composio/ao-plugin-agent-opencode" },
  { slot: "agent", name: "gemini", pkg: "@composio/ao-plugin-agent-gemini" },
  { slot: "agent", name: "cline", pkg: "@composio/ao-plugin-agent-cline" },
  { slot: "agent", name: "copilot", pkg: "@composio/ao-plugin-agent-copilot" },
  { slot: "agent", name: "goose", pkg: "@composio/ao-plugin-agent-goose" },
  { slot: "agent", name: "continue", pkg: "@composio/ao-plugin-agent-continue" },
  { slot: "agent", name: "kiro", pkg: "@composio/ao-plugin-agent-kiro" },
  { slot: "agent", name: "amazon-q", pkg: "@composio/ao-plugin-agent-amazon-q" },
  { slot: "agent", name: "cursor", pkg: "@composio/ao-plugin-agent-cursor" },
  { slot: "agent", name: "auggie", pkg: "@composio/ao-plugin-agent-auggie" },
  { slot: "agent", name: "trae", pkg: "@composio/ao-plugin-agent-trae" },
  { slot: "agent", name: "openhands", pkg: "@composio/ao-plugin-agent-openhands" },
  { slot: "agent", name: "amp", pkg: "@composio/ao-plugin-agent-amp" },
  // Workspaces
  { slot: "workspace", name: "worktree", pkg: "@composio/ao-plugin-workspace-worktree" },
  { slot: "workspace", name: "clone", pkg: "@composio/ao-plugin-workspace-clone" },
  { slot: "workspace", name: "devcontainer", pkg: "@composio/ao-plugin-workspace-devcontainer" },
  { slot: "workspace", name: "overlay", pkg: "@composio/ao-plugin-workspace-overlay" },
  { slot: "workspace", name: "tempdir", pkg: "@composio/ao-plugin-workspace-tempdir" },
  // Trackers
  { slot: "tracker", name: "github", pkg: "@composio/ao-plugin-tracker-github" },
  { slot: "tracker", name: "linear", pkg: "@composio/ao-plugin-tracker-linear" },
  { slot: "tracker", name: "jira", pkg: "@composio/ao-plugin-tracker-jira" },
  { slot: "tracker", name: "gitlab", pkg: "@composio/ao-plugin-tracker-gitlab" },
  { slot: "tracker", name: "shortcut", pkg: "@composio/ao-plugin-tracker-shortcut" },
  { slot: "tracker", name: "azure-devops", pkg: "@composio/ao-plugin-tracker-azure-devops" },
  { slot: "tracker", name: "clickup", pkg: "@composio/ao-plugin-tracker-clickup" },
  { slot: "tracker", name: "plane", pkg: "@composio/ao-plugin-tracker-plane" },
  { slot: "tracker", name: "asana", pkg: "@composio/ao-plugin-tracker-asana" },
  { slot: "tracker", name: "monday", pkg: "@composio/ao-plugin-tracker-monday" },
  // SCM
  { slot: "scm", name: "github", pkg: "@composio/ao-plugin-scm-github" },
  { slot: "scm", name: "gitlab", pkg: "@composio/ao-plugin-scm-gitlab" },
  { slot: "scm", name: "bitbucket", pkg: "@composio/ao-plugin-scm-bitbucket" },
  { slot: "scm", name: "azure-devops", pkg: "@composio/ao-plugin-scm-azure-devops" },
  { slot: "scm", name: "gitea", pkg: "@composio/ao-plugin-scm-gitea" },
  // Notifiers
  { slot: "notifier", name: "composio", pkg: "@composio/ao-plugin-notifier-composio" },
  { slot: "notifier", name: "desktop", pkg: "@composio/ao-plugin-notifier-desktop" },
  { slot: "notifier", name: "slack", pkg: "@composio/ao-plugin-notifier-slack" },
  { slot: "notifier", name: "webhook", pkg: "@composio/ao-plugin-notifier-webhook" },
  { slot: "notifier", name: "discord", pkg: "@composio/ao-plugin-notifier-discord" },
  { slot: "notifier", name: "teams", pkg: "@composio/ao-plugin-notifier-teams" },
  { slot: "notifier", name: "telegram", pkg: "@composio/ao-plugin-notifier-telegram" },
  { slot: "notifier", name: "email", pkg: "@composio/ao-plugin-notifier-email" },
  { slot: "notifier", name: "google-chat", pkg: "@composio/ao-plugin-notifier-google-chat" },
  { slot: "notifier", name: "mattermost", pkg: "@composio/ao-plugin-notifier-mattermost" },
  { slot: "notifier", name: "ntfy", pkg: "@composio/ao-plugin-notifier-ntfy" },
  { slot: "notifier", name: "pagerduty", pkg: "@composio/ao-plugin-notifier-pagerduty" },
  { slot: "notifier", name: "pushover", pkg: "@composio/ao-plugin-notifier-pushover" },
  { slot: "notifier", name: "sms", pkg: "@composio/ao-plugin-notifier-sms" },
  { slot: "notifier", name: "lark", pkg: "@composio/ao-plugin-notifier-lark" },
  { slot: "notifier", name: "dingtalk", pkg: "@composio/ao-plugin-notifier-dingtalk" },
  { slot: "notifier", name: "webex", pkg: "@composio/ao-plugin-notifier-webex" },
  // Terminals
  { slot: "terminal", name: "iterm2", pkg: "@composio/ao-plugin-terminal-iterm2" },
  { slot: "terminal", name: "web", pkg: "@composio/ao-plugin-terminal-web" },
  { slot: "terminal", name: "kitty", pkg: "@composio/ao-plugin-terminal-kitty" },
  { slot: "terminal", name: "wezterm", pkg: "@composio/ao-plugin-terminal-wezterm" },
  { slot: "terminal", name: "zellij", pkg: "@composio/ao-plugin-terminal-zellij" },
  { slot: "terminal", name: "cmux", pkg: "@composio/ao-plugin-terminal-cmux" },
  { slot: "terminal", name: "ghostty", pkg: "@composio/ao-plugin-terminal-ghostty" },
  { slot: "terminal", name: "windows-terminal", pkg: "@composio/ao-plugin-terminal-windows-terminal" },
];

/** Extract plugin-specific config from orchestrator config */
function extractPluginConfig(
  _slot: PluginSlot,
  _name: string,
  _config: OrchestratorConfig,
): Record<string, unknown> | undefined {
  // Reserved for future plugin-specific config mapping
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
      const doImport = importFn ?? ((pkg: string) => import(pkg));
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

      // Then, load any additional plugins specified in project configs
      // (future: support npm package names and local file paths)
    },
  };
}

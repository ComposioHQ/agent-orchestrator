# External Plugins Guide

Agent Orchestrator supports external plugins for trackers, SCM integrations, and notifiers. This allows you to extend AO with custom integrations, connect to private tools, or use community-built plugins.

## Overview

### What Are External Plugins?

External plugins are Node.js modules that implement one of AO's plugin interfaces:

| Slot | Purpose | Example Use Cases |
|------|---------|-------------------|
| `tracker` | Issue/task tracking | Jira, Asana, Trello, Notion |
| `scm` | Source control + PR/CI | Bitbucket, Azure DevOps |
| `notifier` | Push notifications | Telegram, Microsoft Teams, PagerDuty |

### Why Use External Plugins?

- **Custom integrations** — Connect to proprietary internal tools
- **Private deployments** — Use self-hosted versions of supported platforms
- **Community plugins** — Leverage plugins built by the community
- **Specialized workflows** — Build plugins tailored to your team's processes

## Plugin Structure

Every plugin is a standard Node.js ESM module that exports a `PluginModule`:

```typescript
import type { PluginModule, Tracker } from "@composio/ao-core";

// 1. Manifest — declares the plugin's identity
export const manifest = {
  name: "jira",              // Unique plugin name (manifest.name)
  slot: "tracker" as const,  // Which slot this plugin fills
  description: "Jira issue tracker integration",
  version: "1.0.0",
};

// 2. Factory function — creates a configured plugin instance
export function create(config?: Record<string, unknown>): Tracker {
  const host = config?.host as string;
  const apiToken = config?.apiToken as string;

  return {
    name: "jira",
    // ... implement Tracker interface methods
  };
}

// 3. Optional detection — check if the plugin can run
export function detect(): boolean {
  return !!process.env.JIRA_API_TOKEN;
}

// 4. Default export
export default { manifest, create, detect } satisfies PluginModule<Tracker>;
```

### Required Exports

| Export | Required | Description |
|--------|----------|-------------|
| `manifest` | Yes | Plugin identity and metadata |
| `create(config)` | Yes | Factory function returning the plugin instance |
| `detect()` | No | Returns `true` if the plugin's dependencies are available |

### Manifest Fields

```typescript
interface PluginManifest {
  name: string;        // Unique identifier (e.g., "jira", "bitbucket")
  slot: PluginSlot;    // "tracker" | "scm" | "notifier"
  description: string; // Human-readable description
  version: string;     // Semver version
  displayName?: string; // Optional display name (e.g., "Jira Cloud")
}
```

## Configuration Syntax

### Using External Plugins in Projects

External plugins can be specified inline in your `agent-orchestrator.yaml`:

```yaml
projects:
  my-app:
    path: /repos/my-app
    repo: org/my-app
    defaultBranch: main

    # External tracker from npm
    tracker:
      package: "@acme/ao-plugin-tracker-jira"
      host: "https://acme.atlassian.net"
      teamId: "TEAM-123"

    # External SCM from local path
    scm:
      path: ./plugins/my-scm
```

### Using External Notifiers

Notifiers are configured globally under the `notifiers` section:

```yaml
notifiers:
  # External notifier from npm
  telegram:
    package: "@acme/ao-plugin-notifier-telegram"
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: "-1001234567890"

  # External notifier from local path
  teams:
    path: ./plugins/notifier-teams
    webhookUrl: ${TEAMS_WEBHOOK_URL}
```

### Configuration Options

| Field | Description |
|-------|-------------|
| `plugin` | Plugin name (validates against `manifest.name`) |
| `package` | npm package name for external plugins |
| `path` | Local filesystem path (relative to config file or absolute) |
| `...` | Any additional fields are passed to `create(config)` |

### Three Ways to Specify a Plugin

**1. Built-in plugin (plugin only)**
```yaml
tracker:
  plugin: github  # Uses the built-in GitHub tracker
```

**2. External plugin (package/path only)**
```yaml
tracker:
  package: "@acme/ao-plugin-tracker-jira"  # Plugin name inferred from manifest
```

**3. External plugin with validation (plugin + package/path)**
```yaml
tracker:
  plugin: jira  # Will be validated against manifest.name
  package: "@acme/ao-plugin-tracker-jira"
```

## Notification Routing

### The Common Gotcha

Adding a notifier to `defaults.notifiers` is **not enough** to receive notifications. You must also add it to `notificationRouting`:

```yaml
# This alone will NOT send notifications to Telegram:
defaults:
  notifiers:
    - desktop
    - telegram  # Listed but won't receive notifications!

# You MUST also configure routing:
notificationRouting:
  urgent:     # Merge conflicts, stuck sessions, errors
    - desktop
    - telegram
  action:     # CI failures, review comments
    - desktop
    - telegram
  warning:    # Session idle, minor issues
    - telegram
  info:       # PR created, session started
    - telegram
```

### How Notification Routing Works

When an event occurs, AO determines its priority and sends it to the notifiers listed for that priority level:

| Priority | Events |
|----------|--------|
| `urgent` | Merge conflicts, stuck sessions, errors, needs_input |
| `action` | CI failures, review requests, changes requested |
| `warning` | Session idle, PR closed without merge |
| `info` | PR created, session spawned, CI passing |

### Complete Example

```yaml
defaults:
  notifiers:
    - desktop
    - telegram
    - slack

notifiers:
  telegram:
    package: "@acme/ao-plugin-notifier-telegram"
    botToken: ${TELEGRAM_BOT_TOKEN}
    chatId: "-1001234567890"
  slack:
    plugin: webhook
    url: ${SLACK_WEBHOOK_URL}

# Route notifications by priority
notificationRouting:
  urgent:
    - desktop
    - telegram
    - slack
  action:
    - desktop
    - telegram
  warning:
    - slack
  info:
    - slack
```

## Creating a Plugin

### Step 1: Set Up the Package

```bash
mkdir ao-plugin-tracker-jira
cd ao-plugin-tracker-jira
pnpm init
```

Configure `package.json`:

```json
{
  "name": "@acme/ao-plugin-tracker-jira",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "dependencies": {
    "@composio/ao-core": "workspace:*"
  }
}
```

### Step 2: Implement the Interface

#### Tracker Plugin

```typescript
// src/index.ts
import type { PluginModule, Tracker, Issue, ProjectConfig } from "@composio/ao-core";

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Jira Cloud issue tracker",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  const host = config?.host as string;
  const apiToken = process.env.JIRA_API_TOKEN;

  if (!host) {
    console.warn("[tracker-jira] No host configured");
  }

  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      // Fetch issue from Jira API
      const response = await fetch(`${host}/rest/api/3/issue/${identifier}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      const data = await response.json();

      return {
        id: data.key,
        title: data.fields.summary,
        description: data.fields.description ?? "",
        url: `${host}/browse/${data.key}`,
        state: mapJiraStatus(data.fields.status.name),
        labels: data.fields.labels ?? [],
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const issue = await this.getIssue(identifier, project);
      return issue.state === "closed";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      return `${host}/browse/${identifier}`;
    },

    branchName(identifier: string, project: ProjectConfig): string {
      return `${identifier.toLowerCase()}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      return `Fix Jira issue ${issue.id}: ${issue.title}\n\n${issue.description}`;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Tracker>;
```

#### Notifier Plugin

```typescript
// src/index.ts
import type { PluginModule, Notifier, OrchestratorEvent } from "@composio/ao-core";

export const manifest = {
  name: "telegram",
  slot: "notifier" as const,
  description: "Telegram bot notifier",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Notifier {
  const botToken = config?.botToken as string;
  const chatId = config?.chatId as string;

  if (!botToken || !chatId) {
    console.warn("[notifier-telegram] Missing botToken or chatId");
  }

  async function sendMessage(text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  }

  return {
    name: "telegram",

    async notify(event: OrchestratorEvent): Promise<void> {
      const emoji = event.priority === "urgent" ? "🚨" :
                    event.priority === "action" ? "⚡" : "📢";
      await sendMessage(`${emoji} <b>${event.type}</b>\n${event.message}`);
    },

    async post(message: string): Promise<string | null> {
      await sendMessage(message);
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
```

#### SCM Plugin

```typescript
// src/index.ts
import type { PluginModule, SCM, PRInfo, Session, ProjectConfig } from "@composio/ao-core";

export const manifest = {
  name: "bitbucket",
  slot: "scm" as const,
  description: "Bitbucket Cloud SCM integration",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  const workspace = config?.workspace as string;
  const appPassword = process.env.BITBUCKET_APP_PASSWORD;

  return {
    name: "bitbucket",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      // Search for open PR by branch name
      // ... implementation
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      // Fetch PR state from Bitbucket API
      // ... implementation
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      // Fetch pipeline statuses
      // ... implementation
    },

    // ... implement remaining SCM interface methods
  };
}

export default { manifest, create } satisfies PluginModule<SCM>;
```

### Step 3: Build and Test

```bash
# Build
pnpm build

# Test locally by referencing the path
# In agent-orchestrator.yaml:
tracker:
  path: /path/to/ao-plugin-tracker-jira
```

### Step 4: Publish (Optional)

```bash
# Publish to npm
pnpm publish --access public
```

## Interface Requirements

### Tracker Interface

All methods receive `ProjectConfig` which includes tracker-specific config.

| Method | Required | Description |
|--------|----------|-------------|
| `getIssue(id, project)` | Yes | Fetch issue details |
| `isCompleted(id, project)` | Yes | Check if issue is closed |
| `issueUrl(id, project)` | Yes | Generate issue URL |
| `branchName(id, project)` | Yes | Generate git branch name |
| `generatePrompt(id, project)` | Yes | Create agent prompt from issue |
| `issueLabel(url, project)` | No | Extract label from URL (e.g., "JIRA-123") |
| `listIssues(filters, project)` | No | List issues with filters |
| `updateIssue(id, update, project)` | No | Update issue state/labels |
| `createIssue(input, project)` | No | Create a new issue |

### SCM Interface

| Method | Required | Description |
|--------|----------|-------------|
| `detectPR(session, project)` | Yes | Find PR by branch name |
| `getPRState(pr)` | Yes | Get PR state (open/closed/merged) |
| `mergePR(pr, method)` | Yes | Merge the PR |
| `closePR(pr)` | Yes | Close PR without merging |
| `getCIChecks(pr)` | Yes | Get individual CI check statuses |
| `getCISummary(pr)` | Yes | Get overall CI status |
| `getReviews(pr)` | Yes | Get all reviews |
| `getReviewDecision(pr)` | Yes | Get overall review decision |
| `getPendingComments(pr)` | Yes | Get unresolved review comments |
| `getMergeability(pr)` | Yes | Check if PR is mergeable |
| `verifyWebhook(request, project)` | No | Verify webhook signature |
| `parseWebhook(request, project)` | No | Parse webhook payload |

### Notifier Interface

| Method | Required | Description |
|--------|----------|-------------|
| `notify(event)` | Yes | Send a notification |
| `notifyWithActions(event, actions)` | No | Send notification with action buttons |
| `post(message, context)` | No | Post message to a channel |

See `packages/core/src/types.ts` for complete interface definitions.

## Validation Rules

### When `plugin` is Specified

If you specify both `plugin` and `package`/`path`, AO validates that `manifest.name` matches your `plugin` value:

```yaml
tracker:
  plugin: jira  # This MUST match manifest.name in the package
  package: "@acme/ao-plugin-tracker-jira"
```

If they don't match, you'll see a warning:
```
Config validation failed for projects.my-app.tracker: expected "jira" but package has manifest.name "jira-cloud"
```

### When `plugin` is Omitted

If you only specify `package`/`path`, AO infers the plugin name from the manifest:

```yaml
tracker:
  package: "@acme/ao-plugin-tracker-jira"  # plugin name comes from manifest.name
```

### Plugin Name Generation (Temporary)

Before loading, AO generates a temporary name from the package/path:

| Source | Generated Name |
|--------|----------------|
| `@acme/ao-plugin-tracker-jira` | `jira` |
| `@acme/ao-plugin-tracker-jira-cloud` | `jira-cloud` |
| `./plugins/my-tracker` | `my-tracker` |

This temporary name is replaced with `manifest.name` after loading.

### Slot Validation

AO warns if `manifest.slot` doesn't match where you configured the plugin:

```yaml
# Warning: Plugin has slot "notifier" but was configured as "tracker"
tracker:
  package: "@acme/ao-plugin-notifier-telegram"  # Wrong slot!
```

## Troubleshooting

### Plugin Not Found

**Symptoms:** `Plugin "my-plugin" not found` or config validation errors.

**Solutions:**
1. Ensure the package is installed: `pnpm install @acme/ao-plugin-xyz`
2. Rebuild: `pnpm build`
3. Check the package exports ESM correctly (has `"type": "module"` in package.json)

### Notifications Not Working

**Symptoms:** Notifier is configured but no notifications arrive.

**Solution:** Check `notificationRouting`! Adding a notifier to `defaults.notifiers` is not enough:

```yaml
# Wrong - notifications won't be sent:
defaults:
  notifiers:
    - my-notifier

# Correct - add to routing:
notificationRouting:
  urgent:
    - my-notifier
  action:
    - my-notifier
```

### Slot Mismatch Errors

**Symptoms:** Warning about plugin slot not matching config location.

**Solution:** Ensure you're configuring the plugin in the right section:
- `tracker` plugins go in `projects.<id>.tracker`
- `scm` plugins go in `projects.<id>.scm`
- `notifier` plugins go in `notifiers.<id>`

### Path Resolution Issues

**Symptoms:** `Cannot find module` for local plugins.

**Solutions:**
1. Paths are relative to the config file location
2. Use absolute paths to avoid ambiguity: `path: /home/user/plugins/my-plugin`
3. Ensure the plugin is built: check for `dist/index.js`

### Config Field Conflicts

**Symptoms:** Error about `"path" field conflicts with reserved plugin loading field`.

**Solution:** The fields `plugin`, `package`, and `path` are reserved for plugin resolution. Rename your config fields:

```yaml
# Wrong:
tracker:
  package: "@acme/ao-plugin-tracker-jira"
  path: "/api/v3"  # Conflicts with reserved 'path' field!

# Correct:
tracker:
  package: "@acme/ao-plugin-tracker-jira"
  apiPath: "/api/v3"  # Use a different name
```

### Manifest Name Mismatch

**Symptoms:** Warning about expected plugin name not matching manifest.

**Solution:** Either:
1. Update your `plugin` field to match `manifest.name`
2. Remove the `plugin` field to auto-infer from manifest

```yaml
# If manifest.name is "jira-cloud":
tracker:
  plugin: jira-cloud  # Match the manifest
  package: "@acme/ao-plugin-tracker-jira"

# Or let AO infer it:
tracker:
  package: "@acme/ao-plugin-tracker-jira"  # plugin = manifest.name
```

## Best Practices

1. **Validate config in `create()`** — Don't re-validate in every method call
2. **Use environment variables for secrets** — Never hardcode tokens
3. **Implement `detect()`** — Helps users understand if the plugin can run
4. **Handle errors gracefully** — Wrap external API errors with context
5. **Follow naming conventions** — Package: `ao-plugin-{slot}-{name}`, manifest.name: `{name}`
6. **Add TypeScript types** — Export `.d.ts` files for better developer experience
7. **Document config options** — List required and optional config fields in README

## Resources

- [Plugin Spec](./PLUGIN_SPEC.md) — Runtime contract and packaging requirements
- [Core Types](../packages/core/src/types.ts) — Interface definitions
- [Built-in Plugins](../packages/plugins/) — Reference implementations
- [Webhook Notifier](../packages/plugins/notifier-webhook/) — Simple notifier example

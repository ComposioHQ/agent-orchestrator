# Development Guide

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm 9.15+
- Git 2.30+

### First-Time Setup

```bash
# Clone the repository
git clone https://github.com/ComposioHQ/agent-orchestrator.git
cd agent-orchestrator

# Install dependencies
pnpm install

# Build all packages (required before running dev server)
pnpm build

# Copy example config
cp agent-orchestrator.yaml.example agent-orchestrator.yaml

# Configure your settings
$EDITOR agent-orchestrator.yaml
```

### Running the Dev Server

**IMPORTANT**: The web dashboard depends on built packages. Always build before running the dev server:

```bash
# Build all packages
pnpm build

# Start dev server
cd packages/web
pnpm dev

# Open http://localhost:<port> (port from agent-orchestrator.yaml)
```

### Project Structure

```
agent-orchestrator/
├── packages/
│   ├── core/              # Core types, services, config
│   ├── cli/               # CLI tool (ao command)
│   ├── web/               # Next.js dashboard
│   ├── plugins/           # All plugins
│   │   ├── runtime-*/     # Runtime plugins (tmux, docker, k8s)
│   │   ├── agent-*/       # Agent adapters (claude-code, codex, aider)
│   │   ├── workspace-*/   # Workspace providers (worktree, clone)
│   │   ├── tracker-*/     # Issue trackers (github, linear)
│   │   ├── scm-github/    # SCM adapter
│   │   ├── notifier-*/    # Notification channels
│   │   └── terminal-*/    # Terminal UIs
│   └── integration-tests/ # Integration tests
├── agent-orchestrator.yaml.example
├── .gitleaks.toml         # Secret scanning config
├── .husky/                # Git hooks
└── docs/                  # Documentation
```

## Development Workflow

### Making Changes

1. **Create a feature branch**

   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes**
   - Follow [CLAUDE.md](../CLAUDE.md) conventions
   - Add tests for new features
   - Update documentation

3. **Build and test**

   ```bash
   pnpm build
   pnpm test
   pnpm lint
   pnpm typecheck
   ```

4. **Commit**

   ```bash
   git add .
   git commit -m "feat: add your feature"
   ```

   - Pre-commit hook will scan for secrets
   - Use [Conventional Commits](https://www.conventionalcommits.org/)

5. **Push and open PR**
   ```bash
   git push origin feat/your-feature
   ```

### Code Conventions

**TypeScript:**

- ESM modules (`.js` extensions in imports)
- `node:` prefix for builtins
- Strict mode
- `type` imports for type-only
- No `any` (use `unknown` + type guards)
- Semicolons, double quotes, 2-space indent

**Shell Commands:**

- Always use `execFile` (never `exec`)
- Always add timeouts
- Never interpolate user input
- Never use `JSON.stringify` for shell escaping

**Plugin Pattern:**

```typescript
import type { PluginModule, Runtime } from "@composio/ao-core";

export const manifest = {
  name: "my-plugin",
  slot: "runtime" as const,
  description: "My plugin",
  version: "0.1.0",
};

export function create(): Runtime {
  return {
    name: "my-plugin",
    async create(config) {
      /* ... */
    },
    // ... implement interface
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
```

See [CLAUDE.md](../CLAUDE.md) for full conventions.

### Testing

```bash
# Run all tests
pnpm test

# Run tests for specific package
pnpm --filter @composio/ao-core test

# Run tests in watch mode
pnpm --filter @composio/ao-core test -- --watch

# Run integration tests
pnpm test:integration
```

### Working with Worktrees

If using git worktrees (common for parallel agent work):

```bash
# Create worktree
git worktree add ../ao-feature-x feat/feature-x
cd ../ao-feature-x

# Install and build
pnpm install
pnpm build

# Copy config
cp ../agent-orchestrator/agent-orchestrator.yaml .

# Start dev server
cd packages/web
pnpm dev
```

## Security During Development

### Secret Scanning

**Pre-commit hook** runs automatically on every commit:

```bash
🔒 Scanning staged files for secrets...
✅ No secrets detected
```

If secrets are detected:

1. Remove the secret from the file
2. Use environment variables: `${SECRET_NAME}`
3. Add to `.env.local` (in `.gitignore`)
4. Update example configs with placeholders

### What Triggers the Scanner

- API keys: `lin_api_*`, `ghp_*`, `gho_*`, `sk-*`, `AKIA*`
- Tokens: `xoxb-*`, `xoxa-*`, etc.
- Webhooks: `https://hooks.slack.com/*`, `https://discord.com/api/webhooks/*`
- Private keys: `-----BEGIN PRIVATE KEY-----`
- Database URLs: `postgres://user:pass@host`
- Generic patterns: `api_key=...`, `token=...`, `password=...`

### False Positives

If you get a false positive:

1. **Verify it's actually a false positive** (not a real secret!)
2. Update `.gitleaks.toml` allowlist:
   ```toml
   [allowlist]
   regexes = [
     '''your-pattern-here''',
   ]
   ```
3. Commit the `.gitleaks.toml` change first
4. Try committing your file again

### Testing Locally

```bash
# Scan current files (no git history)
gitleaks detect --no-git

# Scan staged files (same as pre-commit hook)
gitleaks protect --staged

# Scan full git history
gitleaks detect
```

## Common Tasks

### Adding a New Plugin

1. **Create plugin package**

   ```bash
   mkdir -p packages/plugins/runtime-myplugin
   cd packages/plugins/runtime-myplugin
   ```

2. **Set up package.json**

   ```json
   {
     "name": "@composio/ao-runtime-myplugin",
     "version": "0.1.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "typecheck": "tsc --noEmit",
       "test": "vitest"
     },
     "dependencies": {
       "@composio/ao-core": "workspace:*"
     }
   }
   ```

3. **Create src/index.ts** (see plugin pattern above)

4. **Register in core** (`packages/core/src/services/plugin-registry.ts`)

5. **Add tests** (`src/index.test.ts`)

6. **Build and test**
   ```bash
   pnpm --filter @composio/ao-runtime-myplugin build
   pnpm --filter @composio/ao-runtime-myplugin test
   ```

### Updating Interfaces

If you change an interface in `packages/core/src/types.ts`:

1. Update the interface
2. Update all implementations (plugins)
3. Update tests
4. Rebuild all packages: `pnpm build`
5. Run all tests: `pnpm test`

### Debugging

**Enable verbose logging:**

```bash
DEBUG=* pnpm dev
```

**Attach to tmux session:**

```bash
tmux attach -t session-name
# Detach: Ctrl-b d
```

**Inspect session metadata:**

```bash
cat ~/.agent-orchestrator/my-app-3
```

**Check session status:**

```bash
curl http://localhost:<port>/api/sessions/my-app-3
```

## Environment Variables

### Development

```bash
# Terminal server ports (for web dashboard)
TERMINAL_PORT=14800
DIRECT_TERMINAL_PORT=14801

# Next.js
NEXT_PUBLIC_TERMINAL_PORT=14800
NEXT_PUBLIC_DIRECT_TERMINAL_PORT=14801
```

### User Secrets

```bash
# GitHub
GITHUB_TOKEN=ghp_...

# Linear
LINEAR_API_KEY=lin_api_...

# Slack
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# Anthropic (for Claude Code agent)
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**NEVER commit these to git!**

Use `.env.local` (in `.gitignore`):

```bash
echo 'GITHUB_TOKEN=ghp_...' >> .env.local
echo 'LINEAR_API_KEY=lin_api_...' >> .env.local
```

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
pnpm clean
pnpm install
pnpm build
```

### Web Dashboard 404s

The web app expects `agent-orchestrator.yaml` in working directory:

```bash
cp agent-orchestrator.yaml.example agent-orchestrator.yaml
```

### Permission Errors in Tests

Some tests require `tmux` or other system tools. Install them:

```bash
# macOS
brew install tmux gitleaks

# Ubuntu
apt-get install tmux
```

### ESM Import Errors

Make sure all packages have `"type": "module"` in `package.json`.

All imports from local files must include `.js` extension:

```typescript
// ✅ Good
import { foo } from "./bar.js";

// ❌ Bad
import { foo } from "./bar";
```

## Resources

- [CLAUDE.md](../CLAUDE.md) — Code conventions and architecture
- [SECURITY.md](../SECURITY.md) — Security best practices
- [packages/core/README.md](../packages/core/README.md) — Core architecture
- [agent-orchestrator.yaml.example](../agent-orchestrator.yaml.example) — Config reference

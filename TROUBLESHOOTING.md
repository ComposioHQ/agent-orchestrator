# Troubleshooting

## DirectTerminal: posix_spawnp failed error

**Symptom**: Terminal in browser shows "Connected" but blank. WebSocket logs show:

```
[DirectTerminal] Failed to spawn PTY: Error: posix_spawnp failed.
```

**Root Cause**: node-pty prebuilt binaries are incompatible with your system.

**Fix**: Rebuild node-pty from source:

```bash
# From the repository root
cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
npx node-gyp rebuild
```

**Verification**:

```bash
# Test node-pty works
node -e "const pty = require('./node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty'); \
  const shell = pty.spawn('/bin/zsh', [], {name: 'xterm-256color', cols: 80, rows: 24, \
  cwd: process.env.HOME, env: process.env}); \
  shell.onData((d) => console.log('✅ OK')); \
  setTimeout(() => process.exit(0), 1000);"
```

**When this happens**:

- After `pnpm install` (uses cached prebuilts)
- After copying the repo to a new location
- On some macOS configurations with Homebrew Node

**Permanent fix**: The postinstall hook automatically rebuilds node-pty:

```bash
pnpm install  # Automatically rebuilds node-pty via postinstall hook
```

### Node 24+ deprecation warning during rebuild

If `pnpm install` prints a `DEP0169` warning about `url.parse()` while rebuilding `node-pty`,
that warning currently comes from `node-gyp`'s dependency stack during the native rebuild step,
not from this repository's source code. The rebuild is still required on Linux because
`node-pty@1.1.0` does not ship Linux prebuilds.

```bash
(node:12345) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized...
```

This warning is harmless for the install flow and can be ignored until the upstream toolchain
stops using the deprecated parser.

If you need to manually rebuild:

```bash
cd node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
npx node-gyp rebuild
```

## Other Issues

### Config file not found

**Symptom**: API returns 500 with "No agent-orchestrator.yaml found"

**Fix**: Ensure config exists in the directory where you run `ao start`, or symlink it:

```bash
ln -s /path/to/agent-orchestrator.yaml packages/web/agent-orchestrator.yaml
```

# Troubleshooting

## Terminal stuck at "Connecting... XDA"

**Symptom**: Session page loads, but terminal never connects and stays at `Connecting... XDA`.

**Root Cause**: One or both websocket backends are down:

- terminal websocket service (`14800`)
- direct terminal websocket service (`14801`)

**Fix**:

```bash
# Check readiness for dashboard + websocket backends
ao services status --strict

# Restart supervised services
ao services stop
ao services start
```

**Expected healthy state**:

- Dashboard reachable on `3000`
- `http://127.0.0.1:14800/health` returns `200`
- `http://127.0.0.1:14801/health` returns `200`

**Prevention**: Use `ao services install` so services are supervised and auto-restarted.

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

# Issue #489: Dashboard fails on linux-arm64 due to missing node-pty prebuilt binary

## Problem Statement

The dashboard fails to start on linux-arm64 platforms (e.g., AWS t4g instances) because:
1. `node-pty` does not provide prebuilt binaries for linux-arm64
2. Building from source requires build tools (gcc, make, node-gyp)
3. Without build tools, `node-pty` fails to load during the direct-terminal-ws import
4. This causes the entire dashboard process to crash when `pnpm dev` runs

## Root Cause

The `direct-terminal-ws.ts` module statically imports `node-pty` at the top level:
```typescript
import { spawn as ptySpawn, type IPty } from "node-pty";
```

When `node-pty` cannot load (missing binary), the import throws an error that:
1. Escapes any try-catch in the calling code
2. Terminates the Node.js process
3. Causes `concurrently` to abort, killing all dev servers (Next.js, ttyd, direct-terminal)

## Solution: Graceful Degradation

Allow the dashboard to start even when `node-pty` is unavailable. Users fall back to the ttyd terminal on port 14800.

### Implementation

#### 1. Dynamic Import with Try-Catch

Replace static import with dynamic import wrapped in try-catch:

```typescript
let ptySpawn: typeof import("node-pty").spawn | null = null;
let nodePtyLoadError: string | null = null;

try {
  const pty = await import("node-pty");
  ptySpawn = pty.spawn;
} catch (err) {
  nodePtyLoadError = err instanceof Error ? err.message : String(err);
  console.error("[DirectTerminal] Failed to load node-pty:", nodePtyLoadError);
  console.error("[DirectTerminal] This is expected on linux-arm64 without build tools installed.");
  console.error("[DirectTerminal] Falling back to ttyd terminal on port 14800.");
  console.error("[DirectTerminal] To enable direct-terminal, install build tools:");
  console.error("[DirectTerminal]   sudo apt-get install build-essential && pnpm install");

  // Exit cleanly (code 0) when running as main module, but allow tests to import
  const isMainModule =
    process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
    process.argv[1]?.endsWith("direct-terminal-ws.js");
  if (isMainModule) {
    process.exit(0);
  }
}
```

**Key Design Decision:** Exit with code 0 (success) only when running as the main module. This ensures:
- `concurrently` continues running other processes
- Users can still access the dashboard and ttyd terminal
- No manual intervention required to start the dashboard
- Tests can import the module without premature exit

#### 2. Update createDirectTerminalServer Signature

Pass the spawn function as a parameter instead of using a global:

```typescript
export function createDirectTerminalServer(
  tmuxPath?: string,
  ptySpawnFn: SpawnFunction,
): DirectTerminalServer {
  // Use ptySpawnFn to spawn PTYs
}
```

**Rationale:**
- Tests can inject a mock spawn function
- Production code uses the loaded `ptySpawn` via `ensurePtySpawn()`
- Fails fast if spawn function is null with a clear error message

#### 3. Add Non-Null Check

```typescript
function ensurePtySpawn(): asserts ptySpawn {
  if (!ptySpawn) {
    throw new Error("[DirectTerminal] ptySpawn not available - node-pty failed to load");
  }
  return ptySpawn;
}
```

Called only in standalone execution path, not in tests.

#### 4. Update dev:direct-terminal Script

```json
"dev:direct-terminal": "tsx watch server/direct-terminal-ws.ts"
```

**Key Design Principle:** The process controls its own exit codes:
- `process.exit(0)` when node-pty is gracefully unavailable (not an error condition)
- Non-zero exit codes for real errors that should surface to developers

This allows `concurrently` to continue running other processes for graceful failures while surfacing actual bugs.

## Flow Diagrams

### Normal Flow (node-pty available)

```
1. pnpm dev
   ↓
2. concurrently runs:
   - next dev
   - tsx watch server/terminal-websocket.ts (ttyd)
   - tsx watch server/direct-terminal-ws.ts
   ↓
3. direct-terminal-ws.ts imports node-pty successfully
   ↓
4. Server starts on port 14801
   ↓
5. Dashboard shows "Direct Terminal" option
   ↓
6. User connects via xterm.js → tmux session
```

### Linux-ARM64 Flow (node-pty unavailable)

```
1. pnpm dev
   ↓
2. concurrently runs:
   - next dev
   - tsx watch server/terminal-websocket.ts (ttyd)
   - tsx watch server/direct-terminal-ws.ts
   ↓
3. direct-terminal-ws.ts import fails
   ↓
4. Try-catch catches error
   ↓
5. Logs helpful messages to console
   ↓
6. Exits with code 0 (clean exit)
   ↓
7. Exit code 0 allows concurrently to continue running other processes
   ↓
8. concurrently continues running next dev and ttyd
   ↓
9. Dashboard shows "Ttyd Terminal" option only
   ↓
10. User connects via ttyd → tmux session
```

## Testing

### Unit Tests

File: `packages/web/server/__tests__/node-pty-graceful-failure.test.ts`

Tests:
1. Module can be imported without crashing
2. `createDirectTerminalServer` accepts mocked `ptySpawnFn`
3. Server is created successfully with mock spawn function

### Integration Tests

File: `packages/web/server/__tests__/direct-terminal-ws.integration.test.ts`

Tests:
1. Full WebSocket connection flow
2. Terminal I/O (echo, resize, special keys)
3. Connection lifecycle (connect, disconnect, errors)
4. Session resolution (exact and hash-prefixed)

**Note:** Tests use a real `node-pty` spawn function because they run on platforms with prebuilt binaries (typically x64 macOS/Linux).

## User Experience

### On linux-arm64 without build tools:

```
$ pnpm dev

> @composio/ao-web@0.1.0 dev /home/deepak/agent-orchestrator
> concurrently "npm:dev:next" "npm:dev:terminal" "npm:dev:direct-terminal"

[0] [Next] Ready on http://localhost:3000
[1] [Ttyd] WebSocket server listening on port 14800
[2] [DirectTerminal] Failed to load node-pty: Error: .../pty.node: cannot open shared object file
[2] [DirectTerminal] This is expected on linux-arm64 without build tools installed.
[2] [DirectTerminal] Falling back to ttyd terminal on port 14800.
[2] [DirectTerminal] To enable direct-terminal, install build tools:
[2] [DirectTerminal]   sudo apt-get install build-essential && pnpm install
[2] [DirectTerminal] Server stopped
```

Dashboard loads at http://localhost:3000 and shows the ttyd terminal option.

### After installing build tools:

```bash
$ sudo apt-get install build-essential
$ pnpm install
# postinstall script rebuilds node-pty from source
$ pnpm dev

> @composio/ao-web@0.1.0 dev /home/deepak/agent-orchestrator
> concurrently "npm:dev:next" "npm:dev:terminal" "npm:dev:direct-terminal"

[0] [Next] Ready on http://localhost:3000
[1] [Ttyd] WebSocket server listening on port 14800
[2] [DirectTerminal] WebSocket server listening on port 14801
```

Dashboard shows both terminal options.

## Alternatives Considered

### Alternative 1: Provide Prebuilt linux-arm64 Binaries

**Pros:**
- Full feature parity on linux-arm64
- No user action required

**Cons:**
- Requires CI to build for linux-arm64
- Larger package size
- Still doesn't solve other platforms (e.g., Windows ARM)
- Doesn't help users without internet access to download binaries

### Alternative 2: Use ttyd as Default Terminal

**Pros:**
- No native module dependencies
- Works everywhere

**Cons:**
- Loses XDA (Extended Device Attributes) support
- Can't implement clipboard in tmux sessions
- Additional process (ttyd binary) to manage

### Alternative 3: Fail Build Instead of Runtime

**Pros:**
- Early detection of missing node-pty
- Clearer error messages for developers

**Cons:**
- Breaks deployment on linux-arm64
- Requires build tools in production environments
- Doesn't allow graceful degradation

## Security Considerations

- The process.exit(0) in the catch block is intentional and safe because:
  - It only exits the direct-terminal-ws subprocess
  - Other processes (Next.js, ttyd) continue running
  - Dashboard remains functional with ttyd terminal fallback

## Trade-offs

| Aspect | With Fix | Without Fix |
|--------|----------|-------------|
| Dashboard starts on linux-arm64 | ✅ Yes | ❌ No |
| Direct terminal on linux-arm64 | ⚠️ Requires build tools | ❌ No (dashboard fails) |
| ttyd terminal on linux-arm64 | ✅ Yes (fallback) | ❌ No (dashboard fails) |
| Developer experience on x64 | ✅ Same | ✅ Same |
| Complexity | Low (try-catch wrapper) | N/A |
| Risk | Low (tested, documented) | N/A |

## Implementation Checklist

- [x] Wrap node-pty import in try-catch
- [x] Exit with code 0 on import failure
- [x] Update createDirectTerminalServer signature to accept ptySpawnFn
- [x] Add ensurePtySpawn() non-null check
- [x] Keep dev:direct-terminal script clean (process controls its exit codes)
- [x] Add unit tests for graceful failure
- [x] Update integration tests to pass mock ptySpawn
- [x] Create design documentation

## Related Issues

- Issue #489: Dashboard fails on linux-arm64 due to missing node-pty
- PR #58: Original direct-terminal implementation
- TROUBLESHOOTING.md: Instructions for rebuilding node-pty manually

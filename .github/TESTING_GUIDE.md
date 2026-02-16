# Testing Guide for Agent Orchestrator

## Quick Start (For Future Agents/Contributors)

**Before making changes to orchestrator setup logic, run this test:**

```bash
./scripts/test-orchestrator-setup.sh
```

**Expected:** All 5 tests pass in ~5 seconds.

## What This Tests

The test verifies the critical path for new users:

1. `ao init --auto` → Creates config **without** `sessionPrefix`
2. `ao start` → Creates orchestrator session with correct naming
3. Session naming follows pattern: `{projectId}-orchestrator` (NOT `undefined-orchestrator`)
4. Metadata file created in correct location
5. tmux session exists and is functional

## Why This Test Exists

**Bug that was fixed (2026-02-16):**

When users ran `ao init`, the config didn't include `sessionPrefix`. Then `ao start` would construct the orchestrator session ID as:

```typescript
const sessionId = `${project.sessionPrefix}-orchestrator`;
// Result: "undefined-orchestrator" ❌
```

The dashboard looks for sessions ending with `-orchestrator`, but couldn't find `undefined-orchestrator`.

**The fix:**

```typescript
const sessionId = `${project.sessionPrefix || projectId}-orchestrator`;
// Result: "my-project-orchestrator" ✅
```

## Manual Testing Procedure

If you need to test manually (see [QUICKTEST.md](../QUICKTEST.md)):

```bash
# 1. Create test environment
mkdir /tmp/ao-test && cd /tmp/ao-test
git init && git remote add origin git@github.com:test/test.git

# 2. Initialize
ao init --auto

# 3. Start orchestrator
ao start --no-dashboard

# 4. Verify session name
tmux list-sessions | grep orchestrator
# Should see: ao-test-orchestrator (NOT undefined-orchestrator)

# 5. Cleanup
tmux kill-session -t ao-test-orchestrator
rm -rf /tmp/ao-test ~/.agent-orchestrator/ao-test-orchestrator
```

## Testing Dashboard Integration

To verify the dashboard shows the "orchestrator terminal" button:

```bash
# 1. Setup test environment (as above)
ao init --auto && ao start

# 2. Check dashboard
curl -s http://localhost:3000 | grep "orchestrator terminal"
# Should find the button text

# 3. Or manually visit
open http://localhost:3000
# Look for "orchestrator terminal" button in top-right header
```

## Common Test Failures

### Test 1 fails: "Session name contains 'undefined'"

**Cause:** The `sessionPrefix` fallback bug is present in `start.ts`

**Fix:** Check these locations in `packages/cli/src/commands/start.ts`:
- Line ~177: `const sessionId = \`\${project.sessionPrefix || projectId}-orchestrator\``
- Line ~369: Same fix in the `stop` command

### Test 2 fails: "Session not found in tmux"

**Cause:** The tmux session creation failed but was not reported

**Debug:**
```bash
# Check tmux sessions
tmux list-sessions

# Check for error in metadata
ls -la ~/.agent-orchestrator/

# Try manual session creation
cd /tmp/ao-test
tmux new-session -d -s test-session
```

### Test 3 fails: "Metadata file not found"

**Cause:** Metadata write failed or wrong path

**Debug:**
```bash
# Check data directory exists
ls -la ~/.agent-orchestrator/

# Check permissions
ls -ld ~/.agent-orchestrator/

# Check config dataDir setting
grep dataDir agent-orchestrator.yaml
```

### Test 5 fails: "Session name doesn't end with '-orchestrator'"

**Cause:** Orchestrator session naming logic changed

**Fix:** Check session ID construction in `start.ts` command

## Integration Tests

For testing as part of CI/CD:

```bash
# Run all tests including orchestrator setup
pnpm test
./scripts/test-orchestrator-setup.sh

# Or add to package.json
{
  "scripts": {
    "test:e2e": "./scripts/test-orchestrator-setup.sh"
  }
}
```

## Files Changed in the Fix

- `packages/cli/src/commands/start.ts` - Added `|| projectId` fallback
- `packages/web/src/components/Dashboard.tsx` - Added helpful tooltip for missing orchestrator
- `scripts/test-orchestrator-setup.sh` - Created automated test
- `QUICKTEST.md` - Created manual test guide
- `README.md` - Added testing section

## Related Documentation

- [QUICKTEST.md](../QUICKTEST.md) - Detailed manual testing procedures
- [SETUP.md](../SETUP.md) - User setup guide
- [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) - Common issues
- [CLAUDE.md](../CLAUDE.md) - Code conventions (includes test command)

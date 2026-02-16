# Quick Verification Test

**Purpose:** Verify the orchestrator setup works correctly from scratch (5 minutes).

## Prerequisites

```bash
# Ensure you've built the project
cd /path/to/agent-orchestrator
pnpm install && pnpm build
```

## Test Setup (Fresh Environment)

```bash
# 1. Create a test directory
mkdir -p /tmp/ao-test
cd /tmp/ao-test

# 2. Initialize a fake git repo (ao init needs this)
git init
git remote add origin git@github.com:test/test-repo.git

# 3. Run ao init with auto mode
ao init --auto

# This creates agent-orchestrator.yaml with:
# - Project ID: ao-test (from directory name)
# - NO sessionPrefix defined (this is the key test case)
# - Default settings
```

## Expected Config

The generated `agent-orchestrator.yaml` should look like:

```yaml
dataDir: ~/.agent-orchestrator
worktreeDir: ~/.worktrees
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  ao-test:
    repo: test/test-repo
    path: /tmp/ao-test
    defaultBranch: main
    # NOTE: No sessionPrefix - this is correct!
```

## Run the Test

```bash
# Start the orchestrator (creates session + dashboard)
ao start --no-dashboard

# Expected output:
# ✔ Orchestrator prompt ready
# ✔ CLAUDE.local.md configured
# ✔ Agent hooks configured
# ✔ Orchestrator session created
#
# Orchestrator: tmux attach -t ao-test-orchestrator
```

## Verify Success

### 1. Check tmux session exists
```bash
tmux list-sessions | grep orchestrator

# Expected: ao-test-orchestrator: 1 windows (created ...)
```

### 2. Check metadata file exists
```bash
cat ~/.agent-orchestrator/ao-test-orchestrator

# Expected:
# worktree=/tmp/ao-test
# branch=main
# status=working
# project=ao-test
# runtimeHandle={"id":"ao-test-orchestrator",...}
```

### 3. Check session name pattern
```bash
# The session ID should be: {projectId}-orchestrator
# NOT: undefined-orchestrator (this was the bug)

tmux list-sessions | grep -E '^ao-test-orchestrator:'
echo $?  # Should print: 0 (success)
```

### 4. Test dashboard detection
```bash
# Start dashboard
ao start &
sleep 5

# Check page source for orchestrator button
curl -s http://localhost:3000 | grep -q "orchestrator terminal"
echo $?  # Should print: 0 (button found)
```

## Expected Results

✅ **PASS**: Session created as `ao-test-orchestrator`
✅ **PASS**: Metadata file exists
✅ **PASS**: Dashboard shows "orchestrator terminal" button

❌ **FAIL**: Session created as `undefined-orchestrator`
❌ **FAIL**: No metadata file
❌ **FAIL**: Button missing or shows "No orchestrator session" tooltip

## Cleanup

```bash
# Kill test session
tmux kill-session -t ao-test-orchestrator

# Remove test data
rm -rf /tmp/ao-test
rm -rf ~/.agent-orchestrator/ao-test-orchestrator

# Stop dashboard
pkill -f "next dev.*3000" || pkill -f "node.*next-server"
```

## Common Issues

### Session named `undefined-orchestrator`
**Problem:** The `sessionPrefix` fallback bug exists in `start.ts`
**Fix:** Ensure lines 177 and 369 use `${project.sessionPrefix || projectId}`

### Button still missing
**Problem:** Dashboard filtering logic not finding orchestrator session
**Fix:** Check `packages/web/src/app/page.tsx` line 23 uses `.endsWith("-orchestrator")`

### Metadata file missing
**Problem:** Session created but metadata write failed
**Check:** Permissions on `~/.agent-orchestrator/` directory

## Testing on Real Project

For testing on an existing project (like integrator):

```bash
cd ~/secondary_checkouts/integrator-1

# Create test config (use unique port to avoid conflicts)
cat > agent-orchestrator.yaml << 'EOF'
dataDir: ~/.agent-orchestrator-test
port: 4567
projects:
  integrator:
    repo: ComposioHQ/integrator
    path: ~/secondary_checkouts/integrator-1
    defaultBranch: next
    # NOTE: No sessionPrefix - tests the fallback
EOF

# Run test
ao start --no-dashboard

# Verify
tmux list-sessions | grep integrator-orchestrator
cat ~/.agent-orchestrator-test/integrator-orchestrator

# Cleanup
tmux kill-session -t integrator-orchestrator
rm -rf ~/.agent-orchestrator-test
rm agent-orchestrator.yaml
```

## Automated Test Script

```bash
#!/bin/bash
# test-orchestrator-setup.sh

set -e

echo "🧪 Testing orchestrator setup..."

# Setup
TEST_DIR="/tmp/ao-quicktest-$$"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"
git init
git remote add origin git@github.com:test/test.git

# Init
ao init --auto --output agent-orchestrator.yaml

# Start (capture session name from output)
OUTPUT=$(ao start --no-dashboard 2>&1)
echo "$OUTPUT"

# Extract session name
SESSION=$(echo "$OUTPUT" | grep -o 'tmux attach -t [^ ]*' | awk '{print $4}')
echo "Session created: $SESSION"

# Verify session name is NOT undefined
if [[ "$SESSION" == *"undefined"* ]]; then
    echo "❌ FAIL: Session name contains 'undefined'"
    exit 1
fi

# Verify session exists
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ FAIL: Session not found in tmux"
    exit 1
fi

# Verify metadata
if [[ ! -f ~/.agent-orchestrator/"$SESSION" ]]; then
    echo "❌ FAIL: Metadata file not found"
    exit 1
fi

echo "✅ PASS: Orchestrator setup working correctly!"

# Cleanup
tmux kill-session -t "$SESSION"
cd /
rm -rf "$TEST_DIR"
```

Save as `scripts/test-orchestrator-setup.sh` and run:
```bash
chmod +x scripts/test-orchestrator-setup.sh
./scripts/test-orchestrator-setup.sh
```

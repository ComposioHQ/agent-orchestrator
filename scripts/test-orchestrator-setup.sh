#!/bin/bash
# Test orchestrator setup from scratch
# Usage: ./scripts/test-orchestrator-setup.sh

set -e

echo "🧪 Testing orchestrator setup..."
echo ""

# Setup
TEST_DIR="/tmp/ao-quicktest-$$"
echo "📁 Creating test directory: $TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Initialize fake git repo (required by ao init)
git init > /dev/null 2>&1
git remote add origin git@github.com:test/test-repo.git

# Run ao init
echo "⚙️  Running: ao init --auto"
ao init --auto --output agent-orchestrator.yaml > /dev/null 2>&1

# Verify config was created
if [[ ! -f agent-orchestrator.yaml ]]; then
    echo "❌ FAIL: agent-orchestrator.yaml not created"
    exit 1
fi

# Check that sessionPrefix is NOT set (this is the test case)
if grep -q "sessionPrefix:" agent-orchestrator.yaml; then
    echo "⚠️  Note: sessionPrefix is set in config (expected to be unset for this test)"
fi

# Start orchestrator
echo "🚀 Running: ao start --no-dashboard"
OUTPUT=$(ao start --no-dashboard 2>&1)

# Extract session name from output
SESSION=$(echo "$OUTPUT" | grep -o 'tmux attach -t [^ ]*' | awk '{print $4}')

if [[ -z "$SESSION" ]]; then
    echo "❌ FAIL: Could not extract session name from ao start output"
    echo "$OUTPUT"
    exit 1
fi

echo "📋 Session created: $SESSION"
echo ""

# Test 1: Verify session name is NOT undefined
echo "Test 1: Session name should not contain 'undefined'"
if [[ "$SESSION" == *"undefined"* ]]; then
    echo "❌ FAIL: Session name contains 'undefined': $SESSION"
    echo "This indicates the sessionPrefix fallback bug is present"
    exit 1
fi
echo "✅ PASS: Session name is valid: $SESSION"

# Test 2: Verify session exists in tmux
echo "Test 2: Session should exist in tmux"
if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "❌ FAIL: Session not found in tmux"
    tmux list-sessions
    exit 1
fi
echo "✅ PASS: Session exists in tmux"

# Test 3: Verify metadata file exists
echo "Test 3: Metadata file should exist"
METADATA_FILE=~/.agent-orchestrator/"$SESSION"
if [[ ! -f "$METADATA_FILE" ]]; then
    echo "❌ FAIL: Metadata file not found: $METADATA_FILE"
    ls -la ~/.agent-orchestrator/ || echo "Directory not found"
    exit 1
fi
echo "✅ PASS: Metadata file exists"

# Test 4: Verify metadata content
echo "Test 4: Metadata should contain correct project"
if ! grep -q "project=" "$METADATA_FILE"; then
    echo "❌ FAIL: Metadata missing 'project' field"
    cat "$METADATA_FILE"
    exit 1
fi
echo "✅ PASS: Metadata is valid"

# Test 5: Verify session name matches pattern {projectId}-orchestrator
echo "Test 5: Session name should match pattern {projectId}-orchestrator"
if [[ ! "$SESSION" =~ -orchestrator$ ]]; then
    echo "❌ FAIL: Session name doesn't end with '-orchestrator': $SESSION"
    exit 1
fi
echo "✅ PASS: Session name matches expected pattern"

echo ""
echo "🎉 All tests passed!"
echo ""
echo "Session: $SESSION"
echo "Metadata: $METADATA_FILE"
echo ""

# Cleanup
echo "🧹 Cleaning up..."
tmux kill-session -t "$SESSION" 2>/dev/null || true
rm -f "$METADATA_FILE"
cd /
rm -rf "$TEST_DIR"

echo "✨ Test complete!"

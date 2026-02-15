#!/bin/bash
# Test script to spawn sessions with different clipboard settings and test

set -e

SESSION_NAME="${1:-clipboard-test-$(date +%s)}"
CLIPBOARD_SETTING="${2:-external}"

echo "================================================"
echo "Clipboard Spawn Test"
echo "================================================"
echo "Session: $SESSION_NAME"
echo "Clipboard setting: $CLIPBOARD_SETTING"
echo ""

# Set the clipboard setting
echo "Setting tmux clipboard to: $CLIPBOARD_SETTING"
tmux set-option -g set-clipboard "$CLIPBOARD_SETTING"

# Verify setting
CURRENT=$(tmux show-options -g set-clipboard | awk '{print $2}')
echo "Current setting: $CURRENT"
echo ""

# Create session
echo "Creating session: $SESSION_NAME"
tmux new-session -d -s "$SESSION_NAME" -c /tmp

# Wait for session to initialize
sleep 1

# Check session exists
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    echo "✅ Session created successfully"
else
    echo "❌ Failed to create session"
    exit 1
fi

# Get session details
echo ""
echo "Session details:"
tmux list-sessions | grep "$SESSION_NAME"

# Check clipboard setting in session
echo ""
echo "Session clipboard setting:"
tmux show-options -t "$SESSION_NAME" -A | grep set-clipboard || echo "  (using global: $CURRENT)"

echo ""
echo "================================================"
echo "Test Instructions:"
echo "================================================"
echo "1. Start ttyd for this session:"
echo "   ttyd --writable --port 7999 --base-path /$SESSION_NAME tmux attach-session -t $SESSION_NAME &"
echo ""
echo "2. Open in browser:"
echo "   http://localhost:7999/$SESSION_NAME/"
echo ""
echo "3. Test clipboard:"
echo "   - Type: echo 'test clipboard'"
echo "   - Select the output text"
echo "   - Press Cmd+C"
echo "   - Try to paste elsewhere"
echo ""
echo "4. To kill session:"
echo "   tmux kill-session -t $SESSION_NAME"
echo "================================================"

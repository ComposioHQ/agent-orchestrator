#!/usr/bin/env bash
#
# Inbox Watcher — Agent Orchestrator Mailbox Polling Service
#
# Polls a session's inbox directory for new messages and delivers them
# to the agent via tmux send-keys. This runs in the background for each
# session and bridges the gap between file-based messaging and agent input.
#
# Environment variables:
#   AO_SESSION    - Session ID (e.g. "ao-10")
#   AO_DATA_DIR   - Base data directory (default: ~/.ao-sessions)
#   POLL_INTERVAL - Polling interval in seconds (default: 5)
#
# Usage:
#   AO_SESSION=ao-10 ~/scripts/inbox-watcher.sh &
#

set -euo pipefail

# Configuration
AO_DATA_DIR="${AO_DATA_DIR:-$HOME/.ao-sessions}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"

# Validate required environment variables
if [[ -z "${AO_SESSION:-}" ]]; then
  echo "ERROR: AO_SESSION environment variable not set" >&2
  exit 1
fi

INBOX="$AO_DATA_DIR/$AO_SESSION/inbox"
SESSION_NAME="$AO_SESSION"

# Ensure inbox directory exists
if [[ ! -d "$INBOX" ]]; then
  echo "ERROR: Inbox directory not found: $INBOX" >&2
  exit 1
fi

# Check if tmux session exists
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "ERROR: tmux session not found: $SESSION_NAME" >&2
  exit 1
fi

echo "Inbox watcher started for session: $SESSION_NAME"
echo "Inbox: $INBOX"
echo "Poll interval: ${POLL_INTERVAL}s"

# Main polling loop
while true; do
  # Find unprocessed messages (sorted by filename/timestamp)
  messages=$(find "$INBOX" -maxdepth 1 -name "*.json" -type f 2>/dev/null | sort || true)

  for msg_file in $messages; do
    echo "Processing message: $(basename "$msg_file")"

    # Parse message using jq (falls back to grep if jq not available)
    if command -v jq &>/dev/null; then
      msg_id=$(jq -r '.id' "$msg_file" 2>/dev/null || echo "unknown")
      msg_type=$(jq -r '.type' "$msg_file" 2>/dev/null || echo "unknown")
      msg_from=$(jq -r '.from' "$msg_file" 2>/dev/null || echo "unknown")
      msg_priority=$(jq -r '.priority' "$msg_file" 2>/dev/null || echo "normal")
      requires_ack=$(jq -r '.requiresAck' "$msg_file" 2>/dev/null || echo "false")
    else
      # Fallback: basic grep parsing
      msg_id=$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$msg_file" | cut -d'"' -f4 || echo "unknown")
      msg_type=$(grep -o '"type"[[:space:]]*:[[:space:]]*"[^"]*"' "$msg_file" | cut -d'"' -f4 || echo "unknown")
      msg_from=$(grep -o '"from"[[:space:]]*:[[:space:]]*"[^"]*"' "$msg_file" | cut -d'"' -f4 || echo "unknown")
      msg_priority="normal"
      requires_ack="false"
    fi

    # Format message for agent based on type
    prompt=""
    case "$msg_type" in
      fix_ci_failure)
        if command -v jq &>/dev/null; then
          pr=$(jq -r '.payload.pr // "Unknown"' "$msg_file")
          check=$(jq -r '.payload.check // "Unknown"' "$msg_file")
          error=$(jq -r '.payload.error // "Unknown"' "$msg_file")
        else
          pr="Unknown"
          check="Unknown"
          error="See message file: $msg_file"
        fi

        prompt="🔧 CI FAILURE DETECTED

Your PR has a failing CI check. Please fix:

Error: $error
PR: $pr
Check: $check"
        ;;

      fix_review_comments)
        if command -v jq &>/dev/null; then
          pr=$(jq -r '.payload.pr // "Unknown"' "$msg_file")
          comments=$(jq -r '.payload.comments[]? | "- \(.path // "?"):\(.line // "?") - \(.body // "")"' "$msg_file" 2>/dev/null || echo "See message file for details")
        else
          pr="Unknown"
          comments="See message file: $msg_file"
        fi

        prompt="📝 REVIEW COMMENTS

Your PR has unresolved review comments. Please address them:

$comments

PR: $pr"
        ;;

      status_request)
        prompt="📊 STATUS REQUEST

Please provide a status update on your current task.

Include: current branch, PR status, blockers, ETA."
        ;;

      shutdown)
        if command -v jq &>/dev/null; then
          reason=$(jq -r '.payload.reason // "Unknown"' "$msg_file")
        else
          reason="Unknown"
        fi

        prompt="🛑 SHUTDOWN REQUEST

The orchestrator is requesting you to shut down.

Reason: $reason"
        ;;

      ack)
        # Acknowledgments are silent, just mark as processed
        echo "Received acknowledgment: $msg_id"
        ;;

      *)
        # Generic message - try to extract text payload
        if command -v jq &>/dev/null; then
          text=$(jq -r '.payload.text // empty' "$msg_file")
          if [[ -n "$text" ]]; then
            prompt="📬 MESSAGE FROM $msg_from

$text"
          else
            # No text field, show raw payload
            payload=$(jq -r '.payload' "$msg_file" 2>/dev/null || echo "{}")
            prompt="📬 MESSAGE FROM $msg_from

$payload"
          fi
        else
          prompt="📬 MESSAGE FROM $msg_from

See message file: $msg_file"
        fi
        ;;
    esac

    # Send prompt to agent via tmux (if not empty)
    if [[ -n "$prompt" ]]; then
      echo "Sending prompt to session $SESSION_NAME"

      # Clear any partial input
      tmux send-keys -t "$SESSION_NAME" C-u 2>/dev/null || true

      # For multi-line prompts, use load-buffer + paste-buffer
      # This is more reliable than send-keys with -l flag for long text
      echo "$prompt" | tmux load-buffer - 2>/dev/null || true
      tmux paste-buffer -t "$SESSION_NAME" 2>/dev/null || true

      # Small delay to let tmux process the pasted text
      sleep 0.3

      # Press Enter to submit
      tmux send-keys -t "$SESSION_NAME" Enter 2>/dev/null || true

      echo "Prompt sent successfully"
    fi

    # Move message to processed/
    mkdir -p "$INBOX/processed"
    mv "$msg_file" "$INBOX/processed/" 2>/dev/null || true
    echo "Moved message to processed/"

    # Send acknowledgment (if required)
    if [[ "$requires_ack" == "true" ]]; then
      echo "Sending acknowledgment to $msg_from"

      # Generate ack message
      ack_id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "ack-$RANDOM-$RANDOM")
      ack_id=$(echo "$ack_id" | tr '[:upper:]' '[:lower:]')
      timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

      ack_file="$AO_DATA_DIR/$msg_from/inbox/${timestamp//:}-${ack_id}-ack.json"

      cat > "$ack_file" << EOF
{
  "id": "$ack_id",
  "from": "$AO_SESSION",
  "to": "$msg_from",
  "timestamp": "$timestamp",
  "type": "ack",
  "priority": "normal",
  "payload": {
    "text": "Message received and displayed to agent"
  },
  "requiresAck": false,
  "replyTo": "$msg_id"
}
EOF

      echo "Acknowledgment sent: $ack_id"
    fi

    echo "---"
  done

  # Sleep before next poll
  sleep "$POLL_INTERVAL"
done

/* eslint-disable no-useless-escape */
/**
 * Bash hook scripts for the file-based communication protocol.
 * These are installed into .claude/settings.json by the agent plugin
 * and run by Claude Code's hook system.
 */

/**
 * PostToolUse hook: reads new inbox messages after every tool call.
 * Uses a cursor file to track the last read byte offset.
 * Outputs new messages via additionalContext JSON.
 *
 * Installed as: .claude/ao-inbox-reader.sh
 * Configured for: PostToolUse (all tools, no matcher filter)
 */
export const INBOX_READER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

INBOX_FILE="\${AO_INBOX_PATH:-}"
if [[ -z "$INBOX_FILE" || ! -f "$INBOX_FILE" ]]; then
  echo '{}'
  exit 0
fi

CURSOR_FILE="\${INBOX_FILE}.hook-cursor"

# Read cursor (byte offset). Default: current file size on first run
# so we only see messages written AFTER the agent started.
cursor=0
if [[ -f "$CURSOR_FILE" ]]; then
  cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  if ! [[ "$cursor" =~ ^[0-9]+$ ]]; then
    cursor=0
  fi
else
  # First run: set cursor to current file size (skip existing messages)
  cursor=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)
  echo "$cursor" > "$CURSOR_FILE"
  echo '{}'
  exit 0
fi

# Get current file size (macOS + Linux compatible)
file_size=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)

# Handle file truncation
if [[ "$file_size" -lt "$cursor" ]]; then
  cursor=0
fi

# Nothing new
if [[ "$file_size" -le "$cursor" ]]; then
  echo '{}'
  exit 0
fi

# Read only new bytes (tail -c + is 1-indexed)
new_bytes=$(tail -c +$(( cursor + 1 )) "$INBOX_FILE" 2>/dev/null || echo "")

if [[ -z "$new_bytes" ]]; then
  echo '{}'
  exit 0
fi

# Truncate to stay under 9500 chars (below 10K additionalContext cap).
# Only advance cursor by the bytes we actually output, so truncated
# messages are re-read on the next hook invocation.
# IMPORTANT: truncate at the last complete newline so we never split
# a JSONL line mid-way. If a single line exceeds 9500 chars, deliver
# it anyway to avoid getting stuck.
# Use byte length (wc -c), not char length, since cursor tracks bytes.
delivered_size=$file_size
if [[ \${#new_bytes} -gt 9500 ]]; then
  # Find last newline within first 9500 chars
  head_chunk="\${new_bytes:0:9500}"
  # Strip everything after the last newline to get complete lines only
  complete_lines="\${head_chunk%\$'\\n'*}"
  if [[ "$complete_lines" == "$head_chunk" || -z "$complete_lines" ]]; then
    # No newline found within 9500 chars — single oversized message.
    # Deliver the whole first line to avoid getting stuck.
    first_line="\${new_bytes%%\$'\\n'*}"
    new_bytes="$first_line"
  else
    # Deliver only complete lines (include the trailing newline)
    new_bytes="$complete_lines
"
  fi
  truncated_byte_len=$(printf '%s' "$new_bytes" | wc -c | tr -d ' ')
  delivered_size=$(( cursor + truncated_byte_len ))
fi

# Update cursor to the bytes actually delivered
echo "$delivered_size" > "$CURSOR_FILE"

# Output as additionalContext JSON
if command -v jq &>/dev/null; then
  escaped=$(echo "$new_bytes" | jq -Rs '.')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PostToolUse\\",\\"additionalContext\\":$escaped}}"
else
  escaped=$(echo "$new_bytes" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"PostToolUse\\",\\"additionalContext\\":\\"$escaped\\"}}"
fi
exit 0
`;

/**
 * Stop hook: prevents the agent from going idle if there are unread inbox messages.
 * Returns exit code 2 with feedback if messages are pending.
 *
 * Installed as: .claude/ao-stop-check.sh
 * Configured for: Stop event
 */
export const STOP_INBOX_CHECK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

INBOX_FILE="\${AO_INBOX_PATH:-}"
if [[ -z "$INBOX_FILE" || ! -f "$INBOX_FILE" ]]; then
  exit 0
fi

CURSOR_FILE="\${INBOX_FILE}.hook-cursor"
BLOCK_COUNT_FILE="\${INBOX_FILE}.stop-blocks"

# Read cursor
cursor=0
if [[ -f "$CURSOR_FILE" ]]; then
  cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  if ! [[ "$cursor" =~ ^[0-9]+$ ]]; then
    cursor=0
  fi
fi

# Get file size (macOS + Linux compatible)
file_size=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)

# No unread messages: allow stop, reset block counter
if [[ "$file_size" -le "$cursor" ]]; then
  rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true
  exit 0
fi

# Safety valve: after 5 consecutive blocks, give up
block_count=0
if [[ -f "$BLOCK_COUNT_FILE" ]]; then
  block_count=$(cat "$BLOCK_COUNT_FILE" 2>/dev/null || echo 0)
fi
block_count=$(( block_count + 1 ))
echo "$block_count" > "$BLOCK_COUNT_FILE"

if [[ "$block_count" -ge 5 ]]; then
  rm -f "$BLOCK_COUNT_FILE" 2>/dev/null || true
  exit 0
fi

# Block the stop: unread messages exist
unread_bytes=$(( file_size - cursor ))
echo "You have unread messages ($unread_bytes bytes) in your inbox at $INBOX_FILE. Read the file and process the messages before stopping." >&2
exit 2
`;

/**
 * UserPromptSubmit hook: reads inbox when the user submits "check inbox".
 * This is triggered when the user submits "check inbox" as a prompt.
 *
 * Installed as: .claude/ao-prompt-inbox.sh
 * Configured for: UserPromptSubmit with matcher "check inbox"
 */
export const PROMPT_INBOX_CHECK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

INBOX_FILE="\${AO_INBOX_PATH:-}"
if [[ -z "$INBOX_FILE" || ! -f "$INBOX_FILE" ]]; then
  echo '{}'
  exit 0
fi

CURSOR_FILE="\${INBOX_FILE}.hook-cursor"

# Read cursor
cursor=0
if [[ -f "$CURSOR_FILE" ]]; then
  cursor=$(cat "$CURSOR_FILE" 2>/dev/null || echo 0)
  if ! [[ "$cursor" =~ ^[0-9]+$ ]]; then
    cursor=0
  fi
fi

# Get file size (macOS + Linux compatible)
file_size=$(stat -f%z "$INBOX_FILE" 2>/dev/null || stat -c%s "$INBOX_FILE" 2>/dev/null || wc -c < "$INBOX_FILE" 2>/dev/null || echo 0)

# Nothing new
if [[ "$file_size" -le "$cursor" ]]; then
  echo '{}'
  exit 0
fi

# Read new bytes
new_bytes=$(tail -c +$(( cursor + 1 )) "$INBOX_FILE" 2>/dev/null || echo "")

if [[ -z "$new_bytes" ]]; then
  echo '{}'
  exit 0
fi

# Truncate to 9500 chars. Only advance cursor by bytes actually delivered.
# IMPORTANT: truncate at the last complete newline so we never split
# a JSONL line mid-way. If a single line exceeds 9500 chars, deliver
# it anyway to avoid getting stuck.
# Use byte length (wc -c), not char length, since cursor tracks bytes.
delivered_size=$file_size
if [[ \${#new_bytes} -gt 9500 ]]; then
  # Find last newline within first 9500 chars
  head_chunk="\${new_bytes:0:9500}"
  # Strip everything after the last newline to get complete lines only
  complete_lines="\${head_chunk%\$'\\n'*}"
  if [[ "$complete_lines" == "$head_chunk" || -z "$complete_lines" ]]; then
    # No newline found within 9500 chars — single oversized message.
    # Deliver the whole first line to avoid getting stuck.
    first_line="\${new_bytes%%\$'\\n'*}"
    new_bytes="$first_line"
  else
    # Deliver only complete lines (include the trailing newline)
    new_bytes="$complete_lines
"
  fi
  truncated_byte_len=$(printf '%s' "$new_bytes" | wc -c | tr -d ' ')
  delivered_size=$(( cursor + truncated_byte_len ))
fi

# Update cursor to the bytes actually delivered
echo "$delivered_size" > "$CURSOR_FILE"

# Output as additionalContext
if command -v jq &>/dev/null; then
  escaped=$(echo "$new_bytes" | jq -Rs '.')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"UserPromptSubmit\\",\\"additionalContext\\":$escaped}}"
else
  escaped=$(echo "$new_bytes" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n' ' ')
  echo "{\\"hookSpecificOutput\\":{\\"hookEventName\\":\\"UserPromptSubmit\\",\\"additionalContext\\":\\"$escaped\\"}}"
fi
exit 0
`;

/**
 * PostToolUse hook: tracks which files the agent touches during Write/Edit/MultiEdit.
 * Appends a JSONL entry to .ao/working-files.jsonl for conflict detection.
 *
 * Installed as: .claude/ao-file-tracker.sh
 * Configured for: PostToolUse (Write, Edit, MultiEdit only)
 */
export const FILE_TRACKER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

# Extract file path from tool input JSON (stdin from Claude Code hook).
# Claude Code passes the tool input as JSON on stdin for PostToolUse hooks.
input=$(cat 2>/dev/null || echo "{}")

FILE=""
if command -v jq &>/dev/null; then
  FILE=$(echo "$input" | jq -r '.tool_input.path // .tool_input.file_path // empty' 2>/dev/null || echo "")
fi

if [[ -z "$FILE" ]]; then
  exit 0
fi

# Normalize to a path RELATIVE to the worktree root so two sessions touching
# the same source file (e.g. src/auth.ts) produce identical strings — required
# for the rebase coordinator's Set-based overlap detection. Absolute paths
# inside the workspace are stripped; absolute paths outside are kept verbatim
# (they intentionally won't match other worktrees).
if [[ "$FILE" = /* ]]; then
  case "$FILE" in
    "\${PWD}"/*) FILE="\${FILE#\${PWD}/}" ;;
  esac
fi

WORKING_FILES=".ao/working-files.jsonl"
mkdir -p .ao 2>/dev/null || true

# Append atomically (single echo < 4KB, safe on ext4/APFS)
echo "{\\"ts\\":$(date +%s000),\\"file\\":\\"$FILE\\"}" >> "$WORKING_FILES"
exit 0
`;

/**
 * Returns the hook configuration to merge into .claude/settings.json.
 * This adds the inbox reader, stop check, prompt inbox, and file tracker hooks
 * alongside the existing metadata-updater.sh hook.
 */
export function getHookSettings(): Record<string, unknown> {
  return {
    hooks: {
      PostToolUse: [
        {
          hooks: [
            {
              type: "command",
              command: ".claude/ao-inbox-reader.sh",
              timeout: 5000,
            },
          ],
        },
        {
          matcher: "Write|Edit|MultiEdit",
          hooks: [
            {
              type: "command",
              command: ".claude/ao-file-tracker.sh",
              timeout: 3000,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: ".claude/ao-stop-check.sh",
              timeout: 5000,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "check inbox",
          hooks: [
            {
              type: "command",
              command: ".claude/ao-prompt-inbox.sh",
              timeout: 5000,
            },
          ],
        },
      ],
    },
  };
}

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// ao-emit bash script
//
// Installed as {workspacePath}/.ao/ao-emit and made executable (0o755).
// Agents call it to write AgentEvent records back to the orchestrator:
//
//   ao-emit <type> <message> [json_data]
//
// Environment variables consumed:
//   AO_AGENT_EVENTS_PATH  - path to the agent-events JSONL file (required;
//                           fail silently if unset so script is safe to call
//                           outside an AO session)
//   AO_SESSION_ID         - session identifier (defaults to "unknown")
//   AO_AGENT_EPOCH        - epoch counter (defaults to 1)
// ---------------------------------------------------------------------------

/* eslint-disable no-useless-escape */
export const AO_EMIT_SCRIPT = `#!/usr/bin/env bash
# ao-emit: write an AgentEvent back to the orchestrator's agent-events file.
# Usage: ao-emit <type> <message> [json_data]
#
# <type>      one of: escalation file_report status completion reject ack
# <message>   free-form string
# [json_data] optional JSON object string merged into the "data" field
#
# Exit 0 on success, 1 on unknown type, silent no-op when AO_AGENT_EVENTS_PATH
# is not set (so the script is safe to call outside an AO session).

set -euo pipefail

# ---- env ---------------------------------------------------------------
EVENTS_FILE="\${AO_AGENT_EVENTS_PATH:-}"
SESSION_ID="\${AO_SESSION_ID:-unknown}"
EPOCH="\${AO_AGENT_EPOCH:-1}"

# Fail silently if the env var is not set — not inside an AO session.
if [ -z "\$EVENTS_FILE" ]; then
  exit 0
fi

# ---- args --------------------------------------------------------------
if [ $# -lt 2 ]; then
  echo "ao-emit: usage: ao-emit <type> <message> [json_data]" >&2
  exit 1
fi

TYPE="\$1"
MESSAGE="\$2"
JSON_DATA="\${3:-}"

# ---- validate type -----------------------------------------------------
case "\$TYPE" in
  escalation|file_report|status|completion|reject|ack)
    ;;
  *)
    echo "ao-emit: unknown event type '\$TYPE'" >&2
    echo "ao-emit: valid types: escalation file_report status completion reject ack" >&2
    exit 1
    ;;
esac

# ---- id counter --------------------------------------------------------
# The counter file lives next to the events file.
COUNTER_FILE="\$(dirname "\$EVENTS_FILE")/.agent-counter"

if [ -f "\$COUNTER_FILE" ]; then
  CURRENT_ID="\$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0)"
  # Strip non-numeric characters in case the file is corrupted.
  CURRENT_ID="\$(echo "\$CURRENT_ID" | tr -cd '0-9')"
  [ -z "\$CURRENT_ID" ] && CURRENT_ID=0
else
  CURRENT_ID=0
fi

NEXT_ID=\$(( CURRENT_ID + 1 ))
printf '%d' "\$NEXT_ID" > "\$COUNTER_FILE"

# ---- timestamp ---------------------------------------------------------
TS="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ---- build JSON line ---------------------------------------------------
# Prefer jq when available for safe string escaping.  Fall back to printf
# with manual escaping of backslash and double-quote characters.

if command -v jq >/dev/null 2>&1; then
  # Build the base object, then optionally merge in json_data.
  BASE_JSON="\$(jq -cn \\
    --arg type    "\$TYPE" \\
    --arg message "\$MESSAGE" \\
    --arg ts      "\$TS" \\
    --argjson v   1 \\
    --argjson id  "\$NEXT_ID" \\
    --argjson epoch "\$EPOCH" \\
    '{v: \$v, id: \$id, epoch: \$epoch, ts: \$ts, source: "agent", type: \$type, message: \$message}')"

  if [ -n "\$JSON_DATA" ]; then
    JSON_LINE="\$(printf '%s' "\$BASE_JSON" | jq -c --argjson data "\$JSON_DATA" '. + {data: \$data}')"
  else
    JSON_LINE="\$BASE_JSON"
  fi
else
  # Manual escaping: replace \\ with \\\\ then " with \\".
  ESC_MSG="\$(printf '%s' "\$MESSAGE" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')"

  if [ -n "\$JSON_DATA" ]; then
    # Include data field as raw JSON (caller is responsible for validity).
    JSON_LINE="\$(printf '{"v":1,"id":%d,"epoch":%s,"ts":"%s","source":"agent","type":"%s","message":"%s","data":%s}' \\
      "\$NEXT_ID" "\$EPOCH" "\$TS" "\$TYPE" "\$ESC_MSG" "\$JSON_DATA")"
  else
    JSON_LINE="\$(printf '{"v":1,"id":%d,"epoch":%s,"ts":"%s","source":"agent","type":"%s","message":"%s"}' \\
      "\$NEXT_ID" "\$EPOCH" "\$TS" "\$TYPE" "\$ESC_MSG")"
  fi
fi

# ---- append (atomic for small writes on local FS) ----------------------
printf '%s\\n' "\$JSON_LINE" >> "\$EVENTS_FILE"

exit 0
`;
/* eslint-enable no-useless-escape */

// ---------------------------------------------------------------------------
// installAoEmit
// ---------------------------------------------------------------------------

/**
 * Install the ao-emit script into {workspacePath}/.ao/ao-emit and make it
 * executable.  Creates the .ao/ directory if it does not yet exist.
 *
 * The script lets agents write AgentEvent records back to the orchestrator by
 * simply calling:
 *
 *   ao-emit <type> <message> [json_data]
 *
 * It is safe to install for all agent types — the script is a no-op when
 * AO_AGENT_EVENTS_PATH is not set.
 */
export async function installAoEmit(workspacePath: string): Promise<void> {
  const aoDir = join(workspacePath, ".ao");
  await mkdir(aoDir, { recursive: true });

  const scriptPath = join(aoDir, "ao-emit");
  await writeFile(scriptPath, AO_EMIT_SCRIPT, "utf-8");
  await chmod(scriptPath, 0o755);
}

export const LOG_FORMATTER_SCRIPT = `#!/usr/bin/env python3
import sys, json

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
        t = d.get("type", "")
        if t == "assistant":
            for c in d.get("message", {}).get("content", []):
                ct = c.get("type", "")
                if ct == "text":
                    print(c["text"], flush=True)
                elif ct == "tool_use":
                    name = c.get("name", "?")
                    inp = c.get("input", {})
                    desc = inp.get("description", inp.get("command", json.dumps(inp)[:120]))
                    print(f"\\033[36m> {name}\\033[0m  {desc}", flush=True)
                elif ct == "thinking":
                    text = c.get("thinking", "")[:200]
                    print(f"\\033[2m(thinking) {text}...\\033[0m", flush=True)
        elif t == "user":
            for c in d.get("message", {}).get("content", []):
                if c.get("type") == "tool_result":
                    content = str(c.get("content", ""))
                    if content and content != "[]":
                        for out_line in content.split("\\n")[:20]:
                            print(f"  {out_line}", flush=True)
        elif t == "result":
            result = d.get("result", "")[:200]
            print(f"\\033[33m[done] {result}\\033[0m", flush=True)
    except (json.JSONDecodeError, KeyError):
        print(line[:200], flush=True)
`;

export async function installLogFormatter(workspacePath: string): Promise<string> {
  const aoDir = join(workspacePath, ".ao");
  await mkdir(aoDir, { recursive: true });

  const scriptPath = join(aoDir, "ao-log-formatter");
  await writeFile(scriptPath, LOG_FORMATTER_SCRIPT, "utf-8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

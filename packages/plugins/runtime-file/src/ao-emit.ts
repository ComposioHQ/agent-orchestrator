import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/* eslint-disable no-useless-escape */
export const AO_EMIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
EVENTS_FILE="\${AO_AGENT_EVENTS_PATH:-}"
SESSION_ID="\${AO_SESSION_ID:-unknown}"
EPOCH="\${AO_AGENT_EPOCH:-1}"
[ -z "\$EVENTS_FILE" ] && exit 0
[ $# -lt 2 ] && { echo "usage: ao-emit <type> <message> [json_data]" >&2; exit 1; }
TYPE="\$1"; MESSAGE="\$2"; JSON_DATA="\${3:-}"
case "\$TYPE" in escalation|file_report|status|completion|reject|ack) ;; *) echo "ao-emit: unknown type '\$TYPE'" >&2; exit 1;; esac

COUNTER_FILE="\$(dirname "\$EVENTS_FILE")/.agent-counter"
CURRENT_ID=0
[ -f "\$COUNTER_FILE" ] && CURRENT_ID="\$(tr -cd '0-9' < "\$COUNTER_FILE" 2>/dev/null || echo 0)"
[ -z "\$CURRENT_ID" ] && CURRENT_ID=0
NEXT_ID=\$(( CURRENT_ID + 1 ))
printf '%d' "\$NEXT_ID" > "\$COUNTER_FILE"

TS="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if command -v jq >/dev/null 2>&1; then
  BASE="\$(jq -cn --arg t "\$TYPE" --arg m "\$MESSAGE" --arg ts "\$TS" --argjson id "\$NEXT_ID" --argjson ep "\$EPOCH" \\
    '{v:1,id:\$id,epoch:\$ep,ts:\$ts,source:"agent",type:\$t,message:\$m}')"
  if [ -n "\$JSON_DATA" ]; then
    JSON_LINE="\$(printf '%s' "\$BASE" | jq -c --argjson d "\$JSON_DATA" '. + {data:\$d}')"
  else JSON_LINE="\$BASE"; fi
else
  [ -n "\$JSON_DATA" ] && { echo "ao-emit: data argument requires jq" >&2; exit 1; }
  ESC_MSG="\$(printf '%s' "\$MESSAGE" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr '\\n\\t\\r' '   ')"
  JSON_LINE="\$(printf '{"v":1,"id":%d,"epoch":%s,"ts":"%s","source":"agent","type":"%s","message":"%s"}' \\
    "\$NEXT_ID" "\$EPOCH" "\$TS" "\$TYPE" "\$ESC_MSG")"
fi
printf '%s\\n' "\$JSON_LINE" >> "\$EVENTS_FILE"
`;
/* eslint-enable no-useless-escape */

export async function installAoEmit(workspacePath: string): Promise<void> {
  const aoDir = join(workspacePath, ".ao");
  await mkdir(aoDir, { recursive: true });
  await writeFile(join(aoDir, "ao-emit"), AO_EMIT_SCRIPT, "utf-8");
  await chmod(join(aoDir, "ao-emit"), 0o755);
}

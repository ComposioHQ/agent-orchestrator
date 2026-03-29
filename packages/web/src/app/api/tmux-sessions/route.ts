import { type NextRequest } from "next/server";
import { execFileSync } from "node:child_process";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

function findTmux(): string {
  const candidates = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  for (const p of candidates) {
    try {
      execFileSync(p, ["-V"], { timeout: 5000 });
      return p;
    } catch {
      continue;
    }
  }
  return "tmux";
}

/** GET /api/tmux-sessions — List all tmux sessions on server */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const tmuxPath = findTmux();
    try {
      const output = execFileSync(tmuxPath, ["list-sessions", "-F", "#{session_name}"], {
        timeout: 5000,
        encoding: "utf8",
      }) as string;
      const sessions = output.split("\n").filter(Boolean);
      return jsonWithCorrelation({ sessions }, { status: 200 }, correlationId);
    } catch {
      // tmux not running or no sessions
      return jsonWithCorrelation({ sessions: [] }, { status: 200 }, correlationId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list tmux sessions";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}

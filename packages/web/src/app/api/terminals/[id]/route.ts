import { type NextRequest } from "next/server";
import { execFileSync } from "node:child_process";
import { validateIdentifier } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { loadTerminals, removeTerminal } from "@/lib/standalone-terminals";

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

/** DELETE /api/terminals/[id] — Remove from registry and optionally kill tmux session */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);

  try {
    const { id } = await params;
    const idErr = validateIdentifier(id, "id");
    if (idErr) {
      return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
    }

    const terminals = loadTerminals();
    const terminal = terminals.find((t) => t.id === id);
    if (!terminal) {
      return jsonWithCorrelation({ error: "Terminal not found" }, { status: 404 }, correlationId);
    }

    // Check if we should kill the tmux session
    const shouldKill = new URL(request.url).searchParams.get("kill") === "true";
    if (shouldKill) {
      try {
        const tmuxPath = findTmux();
        execFileSync(tmuxPath, ["kill-session", "-t", `=${terminal.tmuxName}`], { timeout: 5000 });
      } catch {
        // Session may already be dead — that's fine
      }
    }

    // Remove from registry
    removeTerminal(id);
    return jsonWithCorrelation({}, { status: 200 }, correlationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete terminal";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}

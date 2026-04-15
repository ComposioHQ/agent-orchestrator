import { type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateIdentifier } from "@/lib/validation";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";
import { loadTerminals, saveTerminal, type StandaloneTerminal } from "@/lib/standalone-terminals";
import { findTmuxAsync, getAliveTmuxSessions } from "@/lib/tmux-async";

const execFileAsync = promisify(execFile);

interface TerminalWithAlive extends StandaloneTerminal {
  alive: boolean;
}

/** GET /api/terminals — List all registered terminals with alive status */
export async function GET(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const terminals = loadTerminals();
    const aliveSessions = await getAliveTmuxSessions();
    const withAlive: TerminalWithAlive[] = terminals.map((t) => ({
      ...t,
      alive: aliveSessions.has(t.tmuxName),
    }));
    return jsonWithCorrelation({ terminals: withAlive }, { status: 200 }, correlationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list terminals";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}

interface CreateTerminalRequest {
  tmuxName?: string;
  label?: string;
}

/** POST /api/terminals — Create or register a terminal */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);

  try {
    const body = (await request.json()) as CreateTerminalRequest;
    const { tmuxName: rawTmuxName, label } = body;

    const nameErr = validateIdentifier(rawTmuxName, "tmuxName", 128);
    if (nameErr) {
      return jsonWithCorrelation({ error: nameErr }, { status: 400 }, correlationId);
    }

    // At this point, validation passed, so rawTmuxName is a valid string
    const tmuxName = rawTmuxName as string;

    const tmuxPath = await findTmuxAsync();
    const aliveSessions = await getAliveTmuxSessions();
    const sessionExists = aliveSessions.has(tmuxName);

    // Create tmux session if it doesn't exist
    if (!sessionExists) {
      try {
        await execFileAsync(tmuxPath, ["new-session", "-d", "-s", tmuxName, "-c", homedir()], {
          timeout: 5000,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create tmux session";
        return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
      }
    }

    // Add to registry
    const terminal: StandaloneTerminal = {
      id: randomUUID(),
      tmuxName,
      label: label ?? tmuxName,
      createdAt: new Date().toISOString(),
    };

    saveTerminal(terminal);
    return jsonWithCorrelation({ terminal }, { status: 201 }, correlationId);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return jsonWithCorrelation({ error: "Invalid JSON in request body" }, { status: 400 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to create terminal";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}

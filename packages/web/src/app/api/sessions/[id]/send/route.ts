import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier, validateString, stripControlChars } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@composio/ao-core";

const MAX_MESSAGE_LENGTH = 10_000;

/** POST /api/sessions/:id/send — Send a message to a session */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return NextResponse.json({ error: messageErr }, { status: 400 });
  }

  // Strip control characters to prevent injection when passed to shell-based runtimes
  const message = stripControlChars(String(body?.message ?? ""));

  // Re-validate after stripping — a control-char-only message becomes empty
  if (message.trim().length === 0) {
    return NextResponse.json(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
    );
  }

  try {
    const { sessionManager } = await getServices();
    await sessionManager.send(id, message);
    return NextResponse.json({ ok: true, sessionId: id, message });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const msg = err instanceof Error ? err.message : "Failed to send message";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

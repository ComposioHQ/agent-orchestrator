import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars, validateIdentifier, validateString } from "@/lib/validation";

const MAX_MESSAGE_LENGTH = 10_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Validate session ID to prevent injection
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  // Parse JSON with explicit error handling
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  // Validate message is a non-empty string within length limit
  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return NextResponse.json({ error: messageErr }, { status: 400 });
  }

  // Strip control characters to prevent injection when passed to shell-based runtimes
  const message = stripControlChars(body!.message as string);

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
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send message";
    const status = msg.includes("not found") ? 404 : 500;
    console.error("Failed to send message:", msg);
    return NextResponse.json({ error: msg }, { status });
  }
}

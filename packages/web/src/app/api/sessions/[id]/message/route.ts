import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { stripControlChars, validateIdentifier, validateString } from "@/lib/validation";

const MAX_MESSAGE_LENGTH = 10_000;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;

    // Validate session ID to prevent injection
    const idErr = validateIdentifier(id, "id");
    if (idErr) {
      return NextResponse.json({ error: idErr }, { status: 400 });
    }

    // Parse JSON with explicit error handling
    let body: Record<string, unknown> | null;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }

    // Validate message is a non-empty string within length limit
    const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
    if (messageErr) {
      return NextResponse.json({ error: messageErr }, { status: 400 });
    }

    // Type guard: ensure message is actually a string
    const rawMessage = body?.message;
    if (typeof rawMessage !== "string") {
      return NextResponse.json({ error: "message must be a string" }, { status: 400 });
    }

    // Strip control characters to prevent injection when passed to shell-based runtimes
    const message = stripControlChars(rawMessage);

    // Re-validate after stripping — a control-char-only message becomes empty
    if (message.trim().length === 0) {
      return NextResponse.json(
        { error: "message must not be empty after sanitization" },
        { status: 400 },
      );
    }

    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    try {
      await sessionManager.send(id, message);
      return NextResponse.json({ success: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send message:", errorMsg);
      return NextResponse.json({ error: `Failed to send message: ${errorMsg}` }, { status: 500 });
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

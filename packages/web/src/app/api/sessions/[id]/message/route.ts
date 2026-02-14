import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { message } = await request.json() as { message: string };

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Send message to the session via tmux
    // TODO: This should use the Runtime plugin's sendInput method
    const { spawn } = await import("node:child_process");

    // Escape the message and send it to the tmux session
    // First press Escape to ensure we're not in any special mode
    spawn("tmux", ["send-keys", "-t", id, "Escape"]);

    // Wait a bit for the escape to process
    await new Promise(resolve => setTimeout(resolve, 100));

    // Send the message
    spawn("tmux", ["send-keys", "-t", id, message, "Enter"]);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to send message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

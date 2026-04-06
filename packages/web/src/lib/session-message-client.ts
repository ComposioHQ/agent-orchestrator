"use client";

interface SendSessionMessageResult {
  ok: true;
  success: true;
  sessionId: string;
  message: string;
}

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const maybeError = (payload as { error?: unknown }).error;
  return typeof maybeError === "string" ? maybeError : null;
}

function readStringField(payload: unknown, field: "sessionId" | "message"): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

export async function sendSessionMessage(
  sessionId: string,
  message: string,
): Promise<SendSessionMessageResult> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  const payload = (await response.json().catch(() => null)) as
    | Partial<SendSessionMessageResult>
    | { error?: unknown }
    | null;

  if (!response.ok) {
    const errorMessage = readErrorMessage(payload) ?? `Failed to send message: ${response.status}`;
    throw new Error(errorMessage);
  }

  return {
    ok: true,
    success: true,
    sessionId: readStringField(payload, "sessionId") ?? sessionId,
    message: readStringField(payload, "message") ?? message,
  };
}

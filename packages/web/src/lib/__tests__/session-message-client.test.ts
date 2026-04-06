import { afterEach, describe, expect, it, vi } from "vitest";
import { sendSessionMessage } from "@/lib/session-message-client";

describe("sendSessionMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the canonical send endpoint", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        success: true,
        sessionId: "backend-3",
        message: "Fix the tests",
      }),
    }) as typeof fetch;

    const result = await sendSessionMessage("backend-3", "Fix the tests");

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/backend-3/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Fix the tests" }),
    });
    expect(result).toEqual({
      ok: true,
      success: true,
      sessionId: "backend-3",
      message: "Fix the tests",
    });
  });

  it("throws the API error message when the request fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: "message is required" }),
    }) as typeof fetch;

    await expect(sendSessionMessage("backend-3", "")).rejects.toThrow("message is required");
  });

  it("falls back to the response status when the API body is unavailable", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    }) as typeof fetch;

    await expect(sendSessionMessage("backend-3", "hello")).rejects.toThrow(
      "Failed to send message: 500",
    );
  });
});

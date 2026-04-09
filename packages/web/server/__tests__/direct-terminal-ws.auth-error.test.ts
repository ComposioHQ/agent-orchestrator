import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock("../terminal-auth.js", () => ({
  verifyTerminalAccess: vi.fn(() => {
    throw new Error("authorization backend unavailable");
  }),
  TerminalAuthError: class TerminalAuthError extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, statusCode: number, code: string) {
      super(message);
      this.name = "TerminalAuthError";
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

vi.mock("node-pty", () => ({
  spawn: vi.fn(),
}));

describe("direct terminal websocket auth fallback", () => {
  let shutdown: (() => void) | undefined;
  let port = 0;

  beforeEach(async () => {
    const { createDirectTerminalServer } = await import("../direct-terminal-ws.js");
    const terminal = createDirectTerminalServer("tmux");
    terminal.server.listen(0);
    const address = terminal.server.address();
    port = typeof address === "object" && address ? address.port : 0;
    shutdown = terminal.shutdown;
  });

  afterEach(() => {
    if (shutdown) {
      shutdown();
      shutdown = undefined;
    }
  });

  it("maps generic authorization errors to a policy close", async () => {
    const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?session=ao-auth-fallback`);
      ws.on("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
      ws.on("error", reject);
    });

    expect(closeEvent.code).toBe(1008);
    expect(closeEvent.reason).toBe("authorization backend unavailable");
  });
});

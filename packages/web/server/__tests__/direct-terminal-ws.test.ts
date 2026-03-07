import { describe, it, expect, vi } from "vitest";
import { replaceExistingSession, type TerminalSession } from "../direct-terminal-ws.js";

function makeSession(sessionId: string): TerminalSession {
  const ws = {
    close: vi.fn(),
  };
  const pty = {
    kill: vi.fn(),
  };
  return {
    sessionId,
    ws: ws as unknown as TerminalSession["ws"],
    pty: pty as unknown as TerminalSession["pty"],
  };
}

describe("replaceExistingSession", () => {
  it("returns false when no session exists", () => {
    const sessions = new Map<string, TerminalSession>();
    expect(replaceExistingSession(sessions, "ao-1")).toBe(false);
    expect(sessions.size).toBe(0);
  });

  it("kills PTY, closes websocket, and removes existing session", () => {
    const sessions = new Map<string, TerminalSession>();
    const session = makeSession("ao-1");
    sessions.set("ao-1", session);

    const replaced = replaceExistingSession(sessions, "ao-1");

    expect(replaced).toBe(true);
    expect(sessions.has("ao-1")).toBe(false);
    expect((session.ws.close as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      4009,
      "Replaced by newer connection",
    );
    expect((session.pty.kill as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("handles websocket close errors and still removes session", () => {
    const sessions = new Map<string, TerminalSession>();
    const session = makeSession("ao-2");
    (session.ws.close as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("close failed");
    });
    sessions.set("ao-2", session);

    const replaced = replaceExistingSession(sessions, "ao-2");

    expect(replaced).toBe(true);
    expect(sessions.has("ao-2")).toBe(false);
    expect((session.pty.kill as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("handles PTY kill errors and still removes session", () => {
    const sessions = new Map<string, TerminalSession>();
    const session = makeSession("ao-3");
    (session.pty.kill as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("kill failed");
    });
    sessions.set("ao-3", session);

    const replaced = replaceExistingSession(sessions, "ao-3");

    expect(replaced).toBe(true);
    expect(sessions.has("ao-3")).toBe(false);
    expect((session.ws.close as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});

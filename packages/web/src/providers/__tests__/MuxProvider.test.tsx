import React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MuxProvider, useMux, useMuxOptional } from "../MuxProvider";
import { TERMINAL_CLOSE_SESSION_NOT_FOUND } from "@/lib/mux-protocol";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  sentMessages: string[] = [];

  private _listeners: Map<string, Set<(e: Event) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (e: Event) => void) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (e: Event) => void) {
    this._listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch("close", new CloseEvent("close", { code: 1000, wasClean: true }));
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this._dispatch("open", new Event("open"));
  }

  simulateMessage(data: object) {
    this._dispatch("message", new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch("close", new CloseEvent("close", { code }));
  }

  simulateError() {
    this._dispatch("error", new Event("error"));
  }

  private _dispatch(type: string, event: Event) {
    for (const listener of this._listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  return <MuxProvider>{children}</MuxProvider>;
}

/**
 * Flush the MuxProvider's async init (fetch → connect).
 * Two promise ticks: one for `await fetch(...)`, one for `await res.json()`.
 */
async function flushInit() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // extra flush for connect() state updates
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers(); // always restore timers even if a test fails mid-way
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useMux — outside provider
// ---------------------------------------------------------------------------

describe("useMux outside provider", () => {
  it("throws when used outside MuxProvider", () => {
    expect(() => renderHook(() => useMux())).toThrow("useMux() must be used within <MuxProvider>");
  });
});

describe("useMuxOptional", () => {
  it("returns undefined outside MuxProvider", () => {
    const { result } = renderHook(() => useMuxOptional());
    expect(result.current).toBeUndefined();
  });

  it("returns context value inside MuxProvider", async () => {
    const { result } = renderHook(() => useMuxOptional(), { wrapper });
    await flushInit();
    expect(result.current).toBeDefined();
    expect(result.current!.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe("MuxProvider connection lifecycle", () => {
  it("starts with connecting status", () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    expect(result.current.status).toBe("connecting");
  });

  it("transitions to connected when WebSocket opens", async () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const ws = MockWebSocket.instances[0];

    act(() => ws.simulateOpen());
    expect(result.current.status).toBe("connected");
  });

  it("sends session subscribe message on open", async () => {
    renderHook(() => useMux(), { wrapper });
    await flushInit();

    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    const subMsg = ws.sentMessages.find((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "subscribe";
    });
    expect(subMsg).toBeDefined();
    expect((JSON.parse(subMsg!) as Record<string, unknown>).topics).toContain("sessions");
  });

  it("transitions to reconnecting on close", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => ws.simulateClose());
      expect(result.current.status).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects after backoff delay", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => ws.simulateClose());
      expect(result.current.status).toBe("reconnecting");

      // First reconnect fires after 1000ms
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after unmount", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      unmount();
      const countAtUnmount = MockWebSocket.instances.length;

      act(() => ws.simulateClose());
      act(() => vi.advanceTimersByTime(5000));
      await flushInit();

      expect(MockWebSocket.instances.length).toBe(countAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds proxyWsPath URL from runtime config", async () => {
    renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    // proxyWsPath "/ao-terminal-ws" → basePath "/ao-terminal-ws" → URL ends with /ao-terminal-ws/mux
    expect(MockWebSocket.instances[0].url).toContain("/mux");
  });

  it("falls back gracefully when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    // Still creates a WebSocket (using defaults)
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });

  it("sets disconnected status when WebSocket constructor throws", async () => {
    vi.stubGlobal("WebSocket", vi.fn(() => { throw new Error("unavailable"); }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(result.current.status).toBe("disconnected");
  });

  it("re-opens previously opened terminals on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => result.current.openTerminal("session-abc"));
      // Confirm open message sent on ws1
      expect(ws1.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.type === "open" && p.id === "session-abc";
      })).toBe(true);

      // Disconnect + reconnect
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      // session-abc should be re-opened on ws2
      expect(ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.type === "open" && p.id === "session-abc";
      })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores open event after unmount (isDestroyedRef guard)", async () => {
    const { unmount } = renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const ws = MockWebSocket.instances[0];

    unmount();
    // Simulate late open after unmount — provider should close the socket
    act(() => ws.simulateOpen());

    // The guard closes it
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

describe("MuxProvider message handling", () => {
  async function setupConnected() {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => ws.simulateOpen());
    expect(result.current.status).toBe("connected");
    return { result, ws };
  }

  it("dispatches terminal data to subscribers", async () => {
    const { result, ws } = await setupConnected();

    const received: string[] = [];
    act(() => { result.current.subscribeTerminal("s1", (d) => received.push(d)); });
    act(() => ws.simulateMessage({ ch: "terminal", id: "s1", type: "data", data: "hello" }));

    expect(received).toContain("hello");
  });

  it("tracks opened terminals on 'opened' message", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      act(() => ws1.simulateMessage({ ch: "terminal", id: "s1", type: "opened" }));

      // Reconnect → s1 should be re-opened
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      expect(ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.id === "s1";
      })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches exit notice to subscribers on 'exited' message", async () => {
    const { result, ws } = await setupConnected();

    const received: string[] = [];
    act(() => { result.current.subscribeTerminal("s1", (d) => received.push(d)); });
    act(() => ws.simulateMessage({ ch: "terminal", id: "s1", type: "exited", code: 1 }));

    expect(received.some((m) => m.includes("exited"))).toBe(true);
  });

  it("removes exited terminal from opened set", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      act(() => ws1.simulateMessage({ ch: "terminal", id: "s-x", type: "opened" }));
      act(() => ws1.simulateMessage({ ch: "terminal", id: "s-x", type: "exited", code: 0 }));

      // Reconnect — s-x should NOT be re-opened
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      const reopened = ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.id === "s-x" && p.type === "open";
      });
      expect(reopened).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs terminal error without crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, ws } = await setupConnected();

    act(() => ws.simulateMessage({ ch: "terminal", id: "s1", type: "error", message: "PTY failed" }));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Terminal error"), expect.any(String));
    expect(result.current.status).toBe("connected");
    spy.mockRestore();
  });

  it("updates sessions on snapshot message", async () => {
    const { result, ws } = await setupConnected();

    act(() => ws.simulateMessage({
      ch: "sessions",
      type: "snapshot",
      sessions: [{ id: "s1", status: "working", activity: null, attentionLevel: "working", lastActivityAt: "" }],
    }));

    expect(result.current.sessions.length).toBe(1);
    expect(result.current.sessions[0].id).toBe("s1");
  });

  it("handles malformed JSON message without crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await setupConnected();

    // Manually dispatch a bad MessageEvent
    act(() => {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      const bad = new MessageEvent("message", { data: "not-json{{" });
      (ws as unknown as { _dispatch: (t: string, e: Event) => void })._dispatch("message", bad);
    });

    expect(result.current.status).toBe("connected");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Terminal operations
// ---------------------------------------------------------------------------

describe("MuxProvider terminal operations", () => {
  async function setupConnected() {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => ws.simulateOpen());
    return { result, ws };
  }

  it("writeTerminal sends data message", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.writeTerminal("s1", "hello\n"));
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "terminal" && p.type === "data" && p.data === "hello\n";
    })).toBe(true);
  });

  it("writeTerminal is no-op when WebSocket is not open", async () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    // Don't flush init or open the WebSocket
    act(() => result.current.writeTerminal("s1", "hello\n"));
    // No crash
    expect(result.current.status).toBe("connecting");
  });

  it("openTerminal sends open message when connected", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-abc"));
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "terminal" && p.type === "open" && p.id === "session-abc";
    })).toBe(true);
  });

  it("closeTerminal sends close message", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-abc"));
    act(() => result.current.closeTerminal("session-abc"));
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "terminal" && p.type === "close" && p.id === "session-abc";
    })).toBe(true);
  });

  it("resizeTerminal sends resize message with cols and rows", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.resizeTerminal("session-abc", 120, 40));
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "terminal" && p.type === "resize" && p.cols === 120 && p.rows === 40;
    })).toBe(true);
  });

  it("subscribeTerminal sends open for untracked terminal", async () => {
    const { result, ws } = await setupConnected();
    act(() => { result.current.subscribeTerminal("session-new", () => {}); });
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "terminal" && p.type === "open" && p.id === "session-new";
    })).toBe(true);
  });

  it("subscribeTerminal unsubscribe stops data delivery", async () => {
    const { result, ws } = await setupConnected();
    const received: string[] = [];
    let unsub!: () => void;

    act(() => { unsub = result.current.subscribeTerminal("s1", (d) => received.push(d)); });
    act(() => ws.simulateMessage({ ch: "terminal", id: "s1", type: "data", data: "before" }));
    act(() => unsub());
    act(() => ws.simulateMessage({ ch: "terminal", id: "s1", type: "data", data: "after" }));

    expect(received).toContain("before");
    expect(received).not.toContain("after");
  });
});

// ---------------------------------------------------------------------------
// buildMuxWsUrl — via provider behaviour
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reconnect cap + session-not-found handling
// ---------------------------------------------------------------------------

describe("MuxProvider reconnect cap", () => {
  it("caps reconnects at 8 attempts and transitions to disconnected", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      // Drive 8 close events through failing reconnect cycles. The very
      // first close increments reconnectAttempt → 1 and schedules attempt 1.
      // Subsequent closes on each new instance do the same. After 8 closes
      // we've used all attempts and the 9th close must transition to
      // "disconnected" with NO further socket being created.
      for (let i = 0; i < 8; i++) {
        expect(MockWebSocket.instances.length).toBe(i + 1);
        const ws = MockWebSocket.instances[i];
        act(() => ws.simulateClose());
        expect(result.current.status).toBe("reconnecting");
        // Advance past the backoff delay so the next socket is constructed.
        act(() => vi.advanceTimersByTime(60_000));
        await flushInit();
      }

      // 9th socket now exists; closing it exceeds the cap.
      expect(MockWebSocket.instances.length).toBe(9);
      const lastWs = MockWebSocket.instances[8];
      const countBeforeFinalClose = MockWebSocket.instances.length;
      act(() => lastWs.simulateClose());

      expect(result.current.status).toBe("disconnected");

      // Advance well past any backoff — no new socket should be scheduled.
      act(() => vi.advanceTimersByTime(120_000));
      await flushInit();
      expect(MockWebSocket.instances.length).toBe(countBeforeFinalClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets reconnect attempt counter after a successful open", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      // Burn through a handful of failed reconnects.
      for (let i = 0; i < 5; i++) {
        const ws = MockWebSocket.instances[i];
        act(() => ws.simulateClose());
        act(() => vi.advanceTimersByTime(60_000));
        await flushInit();
      }

      // The next socket succeeds — this must reset reconnectAttempt to 0.
      const okWs = MockWebSocket.instances[5];
      act(() => okWs.simulateOpen());
      expect(result.current.status).toBe("connected");

      // Now fail 8 more times; because the counter reset, we should get
      // 8 fresh reconnect instances (not hit the cap after a handful).
      const baseline = MockWebSocket.instances.length;
      for (let i = 0; i < 8; i++) {
        const ws = MockWebSocket.instances[baseline - 1 + i];
        act(() => ws.simulateClose());
        expect(result.current.status).toBe("reconnecting");
        act(() => vi.advanceTimersByTime(60_000));
        await flushInit();
      }
      expect(MockWebSocket.instances.length).toBe(baseline + 8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("MuxProvider session-not-found (code 4004) handling", () => {
  async function setupConnected() {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => ws.simulateOpen());
    return { result, ws };
  }

  it("dispatches the unavailable notice to subscribers on 4004 error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, ws } = await setupConnected();

    const received: string[] = [];
    act(() => {
      result.current.subscribeTerminal("s-gone", (d) => received.push(d));
    });

    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s-gone",
        type: "error",
        message: "Session not found: s-gone",
        code: TERMINAL_CLOSE_SESSION_NOT_FOUND,
      }),
    );

    expect(received.some((m) => m.includes("Session not found"))).toBe(true);
    expect(received.some((m) => m.includes("terminal unavailable"))).toBe(true);
    spy.mockRestore();
  });

  it("does not re-open the terminal on reconnect after a 4004 error", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      // Mark the terminal as opened on this connection, then the server
      // reports it vanished with the custom 4004 code.
      act(() => {
        result.current.openTerminal("s-gone");
      });
      act(() => ws1.simulateMessage({ ch: "terminal", id: "s-gone", type: "opened" }));
      act(() =>
        ws1.simulateMessage({
          ch: "terminal",
          id: "s-gone",
          type: "error",
          message: "Session not found: s-gone",
          code: TERMINAL_CLOSE_SESSION_NOT_FOUND,
        }),
      );

      // Force a reconnect and confirm s-gone is NOT in the re-open set.
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1_100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      const reopened = ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.type === "open" && p.id === "s-gone";
      });
      expect(reopened).toBe(false);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("ignores generic terminal errors (no code) without clearing the opened set", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      act(() => {
        result.current.openTerminal("s-ok");
      });
      act(() => ws1.simulateMessage({ ch: "terminal", id: "s-ok", type: "opened" }));
      // Generic error — no 4004 code — should NOT remove the terminal.
      act(() =>
        ws1.simulateMessage({
          ch: "terminal",
          id: "s-ok",
          type: "error",
          message: "PTY failed",
        }),
      );

      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1_100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      const reopened = ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.type === "open" && p.id === "s-ok";
      });
      expect(reopened).toBe(true);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("buildMuxWsUrl", () => {
  it("uses directTerminalPort from runtime config when on a custom port", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ directTerminalPort: 14802 }) })),
    );
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost:3000", hostname: "localhost", port: "3000" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toContain(":14802/mux");
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
  });

  it("uses path-based URL when port is empty (reverse proxy)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toMatch(/\/ao-terminal-mux$/);
  });
});

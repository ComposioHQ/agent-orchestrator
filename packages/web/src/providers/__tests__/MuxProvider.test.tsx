import React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MuxProvider, useMux, useMuxOptional } from "../MuxProvider";

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

/** Custom fetch mocks must handle this so MuxProvider can connect to `/mux`. */
function muxConnectFetchResponse() {
  return {
    ok: true,
    json: async () => ({
      token: "mux-test-token",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  };
}

function makeFetchMock() {
  return vi.fn(async (input: string) => {
    if (input === "/api/mux/connect") {
      return muxConnectFetchResponse();
    }

    if (input === "/api/runtime/terminal") {
      return {
        ok: true,
        json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
      };
    }

    if (input.startsWith("/api/sessions/") && input.endsWith("/terminal")) {
      const sessionId = decodeURIComponent(input.split("/")[3] ?? "");
      return {
        ok: true,
        json: async () => ({
          token: `token-for-${sessionId}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      };
    }

    throw new Error(`Unexpected fetch: ${input}`);
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
  vi.stubGlobal("fetch", makeFetchMock());
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

  it("does not open WebSocket when fetch fails before mux token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances.length).toBe(0);
    expect(result.current.status).toBe("disconnected");
  });

  it("sets disconnected status when WebSocket constructor throws", async () => {
    vi.stubGlobal("WebSocket", vi.fn(() => { throw new Error("unavailable"); }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/mux/connect") {
          return muxConnectFetchResponse();
        }
        return { ok: false };
      }),
    );
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
      await flushInit();
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
      await flushInit();

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
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());
      act(() => result.current.openTerminal("s1"));
      await flushInit();

      act(() => ws1.simulateMessage({ ch: "terminal", id: "s1", type: "opened" }));

      // Reconnect → s1 should be re-opened
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());
      await flushInit();

      expect(ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return p.ch === "terminal" && p.id === "s1";
      })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends close for stale opened acknowledgements", async () => {
    const { result, ws } = await setupConnected();

    act(() => result.current.openTerminal("stale-open"));
    act(() => result.current.closeTerminal("stale-open"));
    await flushInit();

    act(() => ws.simulateMessage({ ch: "terminal", id: "stale-open", type: "opened" }));

    expect(ws.sentMessages.some((m) => {
      const payload = JSON.parse(m) as Record<string, unknown>;
      return payload.ch === "terminal" && payload.type === "close" && payload.id === "stale-open";
    })).toBe(true);
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
      sessions: [{ id: "s1", status: "working", activity: null, attentionLevel: "none", lastActivityAt: "" }],
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
    await flushInit();
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return (
        p.ch === "terminal" &&
        p.type === "open" &&
        p.id === "session-abc" &&
        p.token === "token-for-session-abc"
      );
    })).toBe(true);
  });

  it("reuses inflight terminal grant requests", async () => {
    const deferred = createDeferred<{ ok: true; json: () => Promise<{ token: string; expiresAt: string }> }>();
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input === "/api/sessions/session-shared/terminal") {
        return deferred.promise;
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, ws } = await setupConnected();
    act(() => {
      result.current.openTerminal("session-shared");
      result.current.openTerminal("session-shared");
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/sessions/session-shared/terminal")).toHaveLength(1);

    deferred.resolve({
      ok: true,
      json: async () => ({
        token: "shared-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    await flushInit();

    const openMessages = ws.sentMessages
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.ch === "terminal" && m.type === "open" && m.id === "session-shared");
    expect(openMessages).toHaveLength(2);
    expect(openMessages[0]?.["token"]).toBe("shared-token");
  });

  it("logs terminal grant fetch failures", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input === "/api/sessions/session-fail/terminal") {
        return { ok: false, status: 403 };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { result, ws } = await setupConnected();
      act(() => result.current.openTerminal("session-fail"));
      await flushInit();

      expect(errorSpy).toHaveBeenCalledWith(
        "[MuxProvider] Failed to authorize terminal session-fail:",
        "Failed to authorize terminal: HTTP 403",
      );
      expect(ws.sentMessages.some((m) => m.includes("\"session-fail\""))).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs invalid terminal grant responses", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input === "/api/sessions/session-invalid/terminal") {
        return { ok: true, json: async () => ({ token: 123, expiresAt: null }) };
      }
      if (input === "/api/sessions/session-bad-expiry/terminal") {
        return { ok: true, json: async () => ({ token: "ok", expiresAt: "not-a-date" }) };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { result } = await setupConnected();
      act(() => {
        result.current.openTerminal("session-invalid");
        result.current.openTerminal("session-bad-expiry");
      });
      await flushInit();

      expect(errorSpy).toHaveBeenCalledWith(
        "[MuxProvider] Failed to authorize terminal session-invalid:",
        "Terminal authorization response was invalid",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        "[MuxProvider] Failed to authorize terminal session-bad-expiry:",
        "Terminal authorization expiry was invalid",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not send terminal open when the socket closes before auth resolves", async () => {
    const deferred = createDeferred<{ ok: true; json: () => Promise<{ token: string; expiresAt: string }> }>();
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input === "/api/sessions/session-late/terminal") {
        return deferred.promise;
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-late"));
    act(() => ws.simulateClose());

    deferred.resolve({
      ok: true,
      json: async () => ({
        token: "late-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    await flushInit();

    expect(ws.sentMessages.some((m) => m.includes("late-token"))).toBe(false);
  });

  it("does not send terminal open when the terminal closes before auth resolves", async () => {
    const deferred = createDeferred<{ ok: true; json: () => Promise<{ token: string; expiresAt: string }> }>();
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input === "/api/sessions/session-close-race/terminal") {
        return deferred.promise;
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-close-race"));
    act(() => result.current.closeTerminal("session-close-race"));

    deferred.resolve({
      ok: true,
      json: async () => ({
        token: "close-race-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    await flushInit();

    expect(ws.sentMessages.some((m) => m.includes("close-race-token"))).toBe(false);
    expect(ws.sentMessages.some((m) => {
      const payload = JSON.parse(m) as Record<string, unknown>;
      return payload.ch === "terminal" && payload.type === "close" && payload.id === "session-close-race";
    })).toBe(true);
  });

  it("does not send terminal open if the websocket is not open", async () => {
    const { result, ws } = await setupConnected();
    ws.readyState = MockWebSocket.CONNECTING;

    act(() => result.current.openTerminal("session-not-open"));
    await flushInit();

    expect(ws.sentMessages.some((m) => m.includes("session-not-open"))).toBe(false);
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
    await flushInit();
    expect(ws.sentMessages.some((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return (
        p.ch === "terminal" &&
        p.type === "open" &&
        p.id === "session-new" &&
        p.token === "token-for-session-new"
      );
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

describe("buildMuxWsUrl", () => {
  it("uses directTerminalPort from runtime config when on a custom port", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/mux/connect") {
          return muxConnectFetchResponse();
        }
        if (input === "/api/runtime/terminal") {
          return { ok: true, json: async () => ({ directTerminalPort: 14802 }) };
        }
        if (input.startsWith("/api/sessions/") && input.endsWith("/terminal")) {
          const sessionId = decodeURIComponent(input.split("/")[3] ?? "");
          return {
            ok: true,
            json: async () => ({
              token: `token-for-${sessionId}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost:3000", hostname: "localhost", port: "3000" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toContain(":14802/mux");
    expect(MockWebSocket.instances[0].url).toContain("token=");
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
  });

  it("uses path-based URL when port is empty (reverse proxy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (input === "/api/mux/connect") {
          return muxConnectFetchResponse();
        }
        if (input === "/api/runtime/terminal") {
          return { ok: false };
        }
        if (input.startsWith("/api/sessions/") && input.endsWith("/terminal")) {
          const sessionId = decodeURIComponent(input.split("/")[3] ?? "");
          return {
            ok: true,
            json: async () => ({
              token: `token-for-${sessionId}`,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          };
        }
        throw new Error(`Unexpected fetch: ${input}`);
      }),
    );
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toMatch(/\/ao-terminal-mux\?token=/);
  });

  it("refreshes terminal grants after they expire", async () => {
    vi.useFakeTimers();
    let terminalGrantFetchCount = 0;
    const fetchMock = vi.fn(async (input: string) => {
      if (input === "/api/mux/connect") {
        return muxConnectFetchResponse();
      }
      if (input === "/api/runtime/terminal") {
        return { ok: true, json: async () => ({ proxyWsPath: "/ao-terminal-ws" }) };
      }
      if (input.startsWith("/api/sessions/") && input.endsWith("/terminal")) {
        const sessionId = decodeURIComponent(input.split("/")[3] ?? "");
        terminalGrantFetchCount += 1;
        return {
          ok: true,
          json: async () => ({
            token: `token-${sessionId}-${terminalGrantFetchCount}`,
            expiresAt: new Date(Date.now() + 1_000).toISOString(),
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();
      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());
      act(() => result.current.openTerminal("session-expiring"));
      await flushInit();

      act(() => vi.advanceTimersByTime(2_000));
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1_100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());
      await flushInit();

      const openMessages = ws2.sentMessages
        .map((m) => JSON.parse(m) as Record<string, unknown>)
        .filter((m) => m.ch === "terminal" && m.type === "open" && m.id === "session-expiring");

      expect(openMessages).toHaveLength(1);
      expect(openMessages[0]?.["token"]).toBe("token-session-expiring-2");
    } finally {
      vi.useRealTimers();
    }
  });
});

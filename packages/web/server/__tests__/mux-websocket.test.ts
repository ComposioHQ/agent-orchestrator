import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionBroadcaster } from "../mux-websocket";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SessionBroadcaster", () => {
  let broadcaster: SessionBroadcaster;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    broadcaster = new SessionBroadcaster("3000");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makePatch = (id: string) => ({
    id,
    status: "working",
    activity: "active",
    attentionLevel: "working" as const,
    lastActivityAt: new Date().toISOString(),
  });

  describe("subscribe", () => {
    it("sends an immediate snapshot to a new subscriber", async () => {
      const patches = [makePatch("s1")];
      // Mock the snapshot fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      // Mock the SSE connect (hangs forever)
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      const callback = vi.fn();
      broadcaster.subscribe(callback);

      // Let the snapshot fetch resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/sessions/patches",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(callback).toHaveBeenCalledWith(patches);
    });

    it("starts SSE connection on first subscriber", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      // SSE connect
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/events",
        expect.objectContaining({
          headers: { Accept: "text/event-stream" },
        }),
      );
    });

    it("does not start a second SSE connection for additional subscribers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      // SSE connect (first subscriber triggers it)
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      broadcaster.subscribe(vi.fn());
      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // 1 snapshot for sub1 + 1 SSE connect + 1 snapshot for sub2 = 3
      // (SSE connect is only called once)
      const sseConnects = mockFetch.mock.calls.filter(
        (call) => call[0] === "http://localhost:3000/api/events",
      );
      expect(sseConnects).toHaveLength(1);
    });

    it("returns an unsubscribe function that disconnects when last subscriber leaves", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      unsub();
      // After unsubscribe, the abort should be triggered (disconnect)
      // Further subscribe should trigger a new connection
    });
  });

  describe("broadcast", () => {
    it("delivers patches to all subscribers", async () => {
      const patches = [makePatch("s1"), makePatch("s2")];

      // Create a readable stream that sends one SSE event
      const encoder = new TextEncoder();
      const sseData = `data: ${JSON.stringify({ type: "snapshot", sessions: patches })}\n\n`;
      let readerDone = false;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (!readerDone) {
            readerDone = true;
            return { done: false, value: encoder.encode(sseData) };
          }
          return { done: true, value: undefined };
        }),
      };

      // Snapshot fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      // SSE connect returns a stream
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => mockReader },
      });
      // Second subscriber snapshot
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      broadcaster.subscribe(cb1);
      broadcaster.subscribe(cb2);

      await vi.advanceTimersByTimeAsync(10);

      // Both callbacks should have received the broadcast
      expect(cb1).toHaveBeenCalledWith(patches);
      expect(cb2).toHaveBeenCalledWith(patches);
    });

    it("isolates subscriber errors — one throw does not skip others", async () => {
      const patches = [makePatch("s1")];
      const encoder = new TextEncoder();
      const sseData = `data: ${JSON.stringify({ type: "snapshot", sessions: patches })}\n\n`;
      let readerDone = false;
      const mockReader = {
        read: vi.fn().mockImplementation(async () => {
          if (!readerDone) {
            readerDone = true;
            return { done: false, value: encoder.encode(sseData) };
          }
          return { done: true, value: undefined };
        }),
      };

      // Return null for snapshots so the initial callback doesn't fire (and throw)
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockResolvedValueOnce({ ok: true, body: { getReader: () => mockReader } });
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const throwingCb = vi.fn().mockImplementation(() => {
        throw new Error("ws.send failed");
      });
      const goodCb = vi.fn();
      broadcaster.subscribe(throwingCb);
      broadcaster.subscribe(goodCb);

      await vi.advanceTimersByTimeAsync(10);

      expect(goodCb).toHaveBeenCalledWith(patches);
    });
  });

  describe("fetchSnapshot", () => {
    it("returns null on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      // callback should not have been called (snapshot returned null)
      expect(callback).not.toHaveBeenCalled();
    });

    it("returns null on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("SSE reconnection", () => {
    it("reconnects after SSE connection drops if subscribers remain", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) });
      // SSE connect fails
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
      // Reconnect SSE after backoff
      mockFetch.mockReturnValueOnce(new Promise(() => {}));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the 5s reconnect backoff
      await vi.advanceTimersByTimeAsync(6000);

      const sseConnects = mockFetch.mock.calls.filter(
        (call) => call[0] === "http://localhost:3000/api/events",
      );
      expect(sseConnects.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("disconnect", () => {
    it("clears reconnect timer on disconnect", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) });
      // SSE connect fails to trigger reconnect path
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Unsubscribe triggers disconnect, which should clear reconnect timer
      unsub();

      // Advance past reconnect backoff — should NOT trigger a new connect
      mockFetch.mockReturnValueOnce(new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(6000);

      const sseConnects = mockFetch.mock.calls.filter(
        (call) => call[0] === "http://localhost:3000/api/events",
      );
      // Only 1 connect attempt, no reconnect after disconnect
      expect(sseConnects).toHaveLength(1);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSSESessionActivity } from "../useSSESessionActivity";

describe("useSSESessionActivity", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onopen: (() => void) | null;
    onerror: (() => void) | null;
    readyState: number;
    close: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    const eventSourceConstructor = vi.fn(() => {
      const instance = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onopen: null as (() => void) | null,
        onerror: null as (() => void) | null,
        readyState: 0,
        close: vi.fn(),
      };
      eventSourceMock = instance;
      return instance as unknown as EventSource;
    });
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null initially", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));
    expect(result.current).toBeNull();
  });

  it("updates activity when SSE snapshot contains the target session", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-1", status: "working", activity: "active", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
            { id: "session-2", status: "working", activity: "idle", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    expect(result.current).toEqual({ activity: "active" });
  });

  it("updates when activity changes", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-1", status: "working", activity: "active", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    expect(result.current?.activity).toBe("active");

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-1", status: "working", activity: "idle", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    expect(result.current?.activity).toBe("idle");
  });

  it("does not update when activity stays the same (referential stability)", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-1", status: "working", activity: "active", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    const first = result.current;

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-1", status: "working", activity: "active", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    expect(result.current).toBe(first);
  });

  it("ignores snapshots that do not contain the session", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({
          type: "snapshot",
          sessions: [
            { id: "session-other", status: "working", activity: "active", attentionLevel: "working", lastActivityAt: new Date().toISOString() },
          ],
        }),
      } as MessageEvent);
    });

    expect(result.current).toBeNull();
  });

  it("passes project parameter to EventSource URL", () => {
    renderHook(() => useSSESessionActivity("session-1", "my-project"));
    expect(global.EventSource).toHaveBeenCalledWith("/api/events?project=my-project");
  });

  it("uses default URL when no project is specified", () => {
    renderHook(() => useSSESessionActivity("session-1"));
    expect(global.EventSource).toHaveBeenCalledWith("/api/events");
  });

  it("closes EventSource on unmount", () => {
    const { unmount } = renderHook(() => useSSESessionActivity("session-1"));
    unmount();
    expect(eventSourceMock.close).toHaveBeenCalled();
  });

  it("ignores non-snapshot events", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: JSON.stringify({ type: "heartbeat" }),
      } as MessageEvent);
    });

    expect(result.current).toBeNull();
  });

  it("handles malformed JSON gracefully", () => {
    const { result } = renderHook(() => useSSESessionActivity("session-1"));

    act(() => {
      eventSourceMock.onmessage!.call(eventSourceMock, {
        data: "not-json",
      } as MessageEvent);
    });

    expect(result.current).toBeNull();
  });
});

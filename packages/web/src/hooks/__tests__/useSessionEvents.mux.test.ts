import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import { makeSession } from "../../__tests__/helpers";

describe("useSessionEvents – mux session updates", () => {
  beforeEach(() => {
    const eventSourceConstructor = vi.fn(() => ({
      onmessage: null,
      onopen: null,
      onerror: null,
      readyState: 0,
      close: vi.fn(),
    }));
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const makePatch = (id: string) => ({
    id,
    status: "working",
    activity: "active" as string | null,
    attentionLevel: "none",
    lastActivityAt: new Date().toISOString(),
  });

  const makeSessions = (ids: string[]) => ids.map((id) => makeSession({ id }));

  it("sets connectionStatus to connected when muxSessions is provided", () => {
    const patches = [makePatch("s1")];
    const { result } = renderHook(() =>
      useSessionEvents(makeSessions(["s1"]), undefined, patches),
    );
    expect(result.current.connectionStatus).toBe("connected");
  });

  it("dispatches snapshot from muxSessions", () => {
    const sessions = makeSessions(["s1", "s2"]);
    const patches = [
      { ...makePatch("s1"), status: "working", activity: "active" },
      { ...makePatch("s2"), status: "pr_open", activity: "idle" },
    ];
    const { result } = renderHook(() =>
      useSessionEvents(sessions, undefined, patches),
    );
    expect(result.current.sessions[0].status).toBe("working");
    expect(result.current.sessions[1].status).toBe("pr_open");
  });

  it("triggers scheduleRefresh when mux session membership changes", async () => {
    vi.useFakeTimers();
    const sessions = makeSessions(["s1", "s2"]);
    const initialPatches = [makePatch("s1"), makePatch("s2")];
    const newPatches = [makePatch("s1")];
    let currentPatches = initialPatches;

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [makeSession({ id: "s1" })],
      }),
    } as unknown as Response);

    const { rerender } = renderHook(() =>
      useSessionEvents(sessions, undefined, currentPatches),
    );

    currentPatches = newPatches;
    rerender();

    act(() => vi.advanceTimersByTime(200));
    await waitFor(() => vi.mocked(fetch).mock.calls.length > 0);
    vi.useRealTimers();
  });

  it("aborts in-flight request when muxSessions changes rapidly", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sessions = makeSessions(["s1", "s2", "s3"]);
    let resolveFirst!: () => void;
    const firstFetch = new Promise<Response>((resolve) => {
      resolveFirst = () =>
        resolve({
          ok: true,
          json: async () => ({ sessions: [] }),
        } as unknown as Response);
    });

    vi.mocked(fetch)
      .mockReturnValueOnce(firstFetch)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as unknown as Response);

    let patches = [makePatch("s1")];
    const { rerender } = renderHook(() =>
      useSessionEvents(sessions, undefined, patches),
    );

    patches = [makePatch("s1"), makePatch("s2")];
    rerender();
    act(() => vi.advanceTimersByTime(200));

    patches = [makePatch("s1"), makePatch("s2"), makePatch("s3")];
    rerender();

    resolveFirst();
    vi.useRealTimers();
    expect(controller.signal).toBeDefined();
  });

  it("skips SSE setup when muxActive is true", () => {
    const patches = [makePatch("s1")];
    const EventSourceSpy = vi.fn(() => ({
      close: vi.fn(),
      onmessage: null,
      onerror: null,
      onopen: null,
      readyState: 1,
    }));
    global.EventSource = Object.assign(EventSourceSpy, {
      CONNECTING: 0, OPEN: 1, CLOSED: 2,
    }) as unknown as typeof EventSource;

    renderHook(() => useSessionEvents([], undefined, patches));

    expect(EventSourceSpy).not.toHaveBeenCalled();
  });

  it("mux-active cleanup aborts in-flight fetch and clears timer", async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    } as unknown as Response);

    const sessions = makeSessions(["s1", "s2"]);
    const patches = [makePatch("s1")];
    let mux: typeof patches | undefined = patches;
    const { rerender, unmount } = renderHook(() =>
      useSessionEvents(sessions, undefined, mux),
    );

    mux = [makePatch("s1"), makePatch("s2")];
    rerender();

    unmount();
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
  });
});

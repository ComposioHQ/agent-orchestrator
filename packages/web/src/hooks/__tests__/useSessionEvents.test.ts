import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession, GlobalPauseState } from "../../lib/types";
import { makeSession } from "../../__tests__/helpers";

describe("useSessionEvents", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };
  let eventSourceInstances: (typeof eventSourceMock)[];

  beforeEach(() => {
    eventSourceInstances = [];
    const eventSourceConstructor = vi.fn(() => {
      const instance = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as (() => void) | null,
        close: vi.fn(),
      };
      eventSourceInstances.push(instance);
      eventSourceMock = instance;
      return instance as unknown as EventSource;
    });
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

  const makeSessions = (count: number): DashboardSession[] =>
    Array.from({ length: count }, (_, i) => makeSession({ id: `session-${i}` }));

  const makeGlobalPause = (overrides: Partial<GlobalPauseState> = {}): GlobalPauseState => ({
    pausedUntil: new Date(Date.now() + 3600000).toISOString(),
    reason: "Model rate limit reached",
    sourceSessionId: "session-1",
    ...overrides,
  });

  describe("initial state", () => {
    it("returns initial sessions and globalPause", () => {
      const sessions = makeSessions(2);
      const globalPause = makeGlobalPause();

      const { result } = renderHook(() => useSessionEvents(sessions, globalPause));

      expect(result.current.sessions).toEqual(sessions);
      expect(result.current.globalPause).toEqual(globalPause);
    });

    it("accepts null globalPause", () => {
      const sessions = makeSessions(1);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      expect(result.current.sessions).toEqual(sessions);
      expect(result.current.globalPause).toBeNull();
    });
  });

  describe("globalPause state updates from /api/sessions", () => {
    it("updates globalPause when membership changes and /api/sessions returns new pause state", async () => {
      const initialSessions = makeSessions(2);
      const initialPause: GlobalPauseState = makeGlobalPause({ reason: "Initial pause" });

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [...initialSessions, makeSession({ id: "session-new" })],
          globalPause: makeGlobalPause({ reason: "Updated pause from different provider" }),
        }),
      } as unknown as Response);

      const { result } = renderHook(() => useSessionEvents(initialSessions, initialPause));

      expect(result.current.globalPause?.reason).toBe("Initial pause");

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-1",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause?.reason).toBe("Updated pause from different provider");
      });
    });

    it("clears globalPause when /api/sessions returns null pause", async () => {
      const initialSessions = makeSessions(2);
      const initialPause = makeGlobalPause();

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [...initialSessions, makeSession({ id: "session-new" })],
          globalPause: null,
        }),
      } as unknown as Response);

      const { result } = renderHook(() => useSessionEvents(initialSessions, initialPause));

      expect(result.current.globalPause).not.toBeNull();

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-1",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause).toBeNull();
      });
    });

    it("sets globalPause when initially null and /api/sessions returns pause", async () => {
      const initialSessions = makeSessions(2);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [...initialSessions, makeSession({ id: "session-new" })],
          globalPause: makeGlobalPause({ reason: "New rate limit detected" }),
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(initialSessions, null));

      expect(result.current.globalPause).toBeNull();

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-1",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause?.reason).toBe("New rate limit detected");
      });
    });

    it("refreshes globalPause on stale same-membership snapshots without waiting for membership churn", async () => {
      vi.useFakeTimers();
      const initialSessions = makeSessions(2);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: initialSessions,
          globalPause: makeGlobalPause({ reason: "Pause updated during steady-state SSE" }),
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(initialSessions, null));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: initialSessions.map((session) => ({
              id: session.id,
              status: session.status,
              activity: session.activity,
              lastActivityAt: session.lastActivityAt,
            })),
          }),
        } as MessageEvent);
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("/api/sessions", { signal: expect.any(AbortSignal) });
      expect(result.current.globalPause?.reason).toBe("Pause updated during steady-state SSE");
    });
  });

  describe("provider-agnostic behavior", () => {
    it("handles globalPause from Claude Code agent without provider-specific logic", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions,
          globalPause: {
            pausedUntil: new Date(Date.now() + 7200000).toISOString(),
            reason: "usage limit reached for 2 hours",
            sourceSessionId: "claude-session-1",
          },
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause?.reason).toBe("usage limit reached for 2 hours");
        expect(result.current.globalPause?.sourceSessionId).toBe("claude-session-1");
      });
    });

    it("handles globalPause from OpenCode agent without provider-specific logic", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions,
          globalPause: {
            pausedUntil: new Date(Date.now() + 1800000).toISOString(),
            reason: "Model capacity exceeded",
            sourceSessionId: "opencode-session-42",
          },
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause?.reason).toBe("Model capacity exceeded");
        expect(result.current.globalPause?.sourceSessionId).toBe("opencode-session-42");
      });
    });

    it("handles globalPause from Codex agent without provider-specific logic", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions,
          globalPause: {
            pausedUntil: new Date(Date.now() + 3600000).toISOString(),
            reason: "API quota exhausted",
            sourceSessionId: "codex-worker-99",
          },
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(result.current.globalPause?.reason).toBe("API quota exhausted");
        expect(result.current.globalPause?.sourceSessionId).toBe("codex-worker-99");
      });
    });
  });

  describe("session state updates", () => {
    it("applies snapshot patches to sessions", async () => {
      const sessions = makeSessions(2);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "pr_open",
                activity: "idle",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      expect(result.current.sessions[0].status).toBe("pr_open");
      expect(result.current.sessions[0].activity).toBe("idle");
      expect(result.current.sessions[1].status).toBe("working");
    });

    it("preserves untouched session references across snapshot patches", async () => {
      const sessions = makeSessions(2);

      const { result } = renderHook(() => useSessionEvents(sessions, null));
      const untouchedSession = result.current.sessions[1];

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "pr_open",
                activity: "idle",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      expect(result.current.sessions[0]).not.toBe(sessions[0]);
      expect(result.current.sessions[1]).toBe(untouchedSession);
    });

    it("coalesces bursty membership changes into a single refresh fetch", async () => {
      vi.useFakeTimers();
      const initialSessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [
            ...initialSessions,
            makeSession({ id: "session-1" }),
            makeSession({ id: "session-2" }),
            makeSession({ id: "session-3" }),
          ],
          globalPause: null,
        }),
      } as Response);

      renderHook(() => useSessionEvents(initialSessions, null));

      await act(async () => {
        for (const sessionId of ["session-1", "session-2", "session-3"]) {
          eventSourceMock!.onmessage!.call(eventSourceMock, {
            data: JSON.stringify({
              type: "snapshot",
              sessions: [
                {
                  id: "session-0",
                  status: "working",
                  activity: "active",
                  lastActivityAt: new Date().toISOString(),
                },
                {
                  id: sessionId,
                  status: "working",
                  activity: "active",
                  lastActivityAt: new Date().toISOString(),
                },
              ],
            }),
          } as MessageEvent);
        }

        await vi.advanceTimersByTimeAsync(120);
        await Promise.resolve();
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith("/api/sessions", { signal: expect.any(AbortSignal) });
    });

    it("ignores stale refresh completions after project changes", async () => {
      vi.useFakeTimers();
      const alphaSessions = [makeSession({ id: "alpha-0", projectId: "alpha" })];
      const betaSessions = [makeSession({ id: "beta-0", projectId: "beta" })];
      let resolveAlphaFetch: ((value: Response) => void) | null = null;

      vi.mocked(fetch).mockImplementation((input) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("project=alpha")) {
          return new Promise<Response>((resolve) => {
            resolveAlphaFetch = resolve;
          });
        }

        return Promise.resolve({
          ok: true,
          json: async () => ({
            sessions: [...betaSessions, makeSession({ id: "beta-1", projectId: "beta" })],
            globalPause: null,
          }),
        } as unknown as Response);
      });

      const { result, rerender } = renderHook(
        ({ sessions, project }) => useSessionEvents(sessions, null, project),
        {
          initialProps: { sessions: alphaSessions, project: "alpha" },
        },
      );

      await act(async () => {
        eventSourceInstances[0].onmessage?.({
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "alpha-0",
                status: "working",
                activity: "active",
                lastActivityAt: alphaSessions[0].lastActivityAt,
              },
              {
                id: "alpha-1",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenNthCalledWith(1, "/api/sessions?project=alpha", {
        signal: expect.any(AbortSignal),
      });

      rerender({ sessions: betaSessions, project: "beta" });

      await act(async () => {
        resolveAlphaFetch?.({
          ok: true,
          json: async () => ({
            sessions: [...alphaSessions, makeSession({ id: "alpha-1", projectId: "alpha" })],
            globalPause: null,
          }),
        } as unknown as Response);
        await Promise.resolve();
      });

      expect(result.current.sessions).toEqual(betaSessions);

      await act(async () => {
        eventSourceInstances[1].onmessage?.({
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "beta-0",
                status: "working",
                activity: "active",
                lastActivityAt: betaSessions[0].lastActivityAt,
              },
              {
                id: "beta-1",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(2, "/api/sessions?project=beta", {
        signal: expect.any(AbortSignal),
      });
    });

    it("swallows refresh fetch JSON failures without resetting sessions", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      } as unknown as Response);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith("/api/sessions", {
          signal: expect.any(AbortSignal),
        });
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe("session-0");
    });

    it("preserves the current dashboard view on membership refresh", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions,
          globalPause: null,
          stats: {
            totalSessions: sessions.length,
            workingSessions: sessions.length,
            openPRs: 0,
            needsReview: 0,
          },
          orchestrators: [],
          view: "pixel",
        }),
      } as unknown as Response);

      renderHook(() => useSessionEvents(sessions, null, "alpha", "pixel"));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
              {
                id: "session-new",
                status: "working",
                activity: "active",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith("/api/sessions?project=alpha&view=pixel", {
          signal: expect.any(AbortSignal),
        });
      });
    });

    it("tracks alignment drift from snapshot attention buckets and exposes a manual refresh path", async () => {
      vi.useFakeTimers();
      const sessions = [makeSession({ id: "session-0", status: "working", activity: "active" })];

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessions: [makeSession({ id: "session-0", status: "review_pending", activity: "idle" })],
          globalPause: null,
        }),
      } as Response);

      const { result } = renderHook(() => useSessionEvents(sessions, null));

      await act(async () => {
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                attentionLevel: "review",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
        await vi.advanceTimersByTimeAsync(2600);
        eventSourceMock!.onmessage!.call(eventSourceMock, {
          data: JSON.stringify({
            type: "snapshot",
            sessions: [
              {
                id: "session-0",
                status: "working",
                activity: "active",
                attentionLevel: "review",
                lastActivityAt: new Date().toISOString(),
              },
            ],
          }),
        } as MessageEvent);
      });

      expect(result.current.alignment.status).toBe("drifted");
      expect(result.current.alignment.affectedLevels).toEqual(["review", "working"]);

      await act(async () => {
        result.current.refreshNow();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(result.current.alignment.status).toBe("aligned");
      expect(result.current.sessions[0].status).toBe("review_pending");
    });
  });
});

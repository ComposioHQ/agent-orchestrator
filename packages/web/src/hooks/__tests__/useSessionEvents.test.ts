import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession, GlobalPauseState } from "@/lib/types";
import { makeSession } from "@/__tests__/helpers";

describe("useSessionEvents", () => {
  let eventSourceMock: {
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: (() => void) | null;
    close: () => void;
  };
  let eventSourceInstances: (typeof eventSourceMock)[];

  beforeEach(() => {
    eventSourceInstances = [];
    global.EventSource = vi.fn(() => {
      const instance = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as (() => void) | null,
        close: vi.fn(),
      };
      eventSourceInstances.push(instance);
      eventSourceMock = instance;
      return instance as unknown as EventSource;
    });
    global.fetch = vi.fn();
  });

  afterEach(() => {
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
      } as Response);

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

      expect(result.current.globalPause?.reason).toBe("Updated pause from different provider");
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
      } as Response);

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

      expect(result.current.globalPause).toBeNull();
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

      expect(result.current.globalPause?.reason).toBe("New rate limit detected");
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

      expect(result.current.globalPause?.reason).toBe("usage limit reached for 2 hours");
      expect(result.current.globalPause?.sourceSessionId).toBe("claude-session-1");
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

      expect(result.current.globalPause?.reason).toBe("Model capacity exceeded");
      expect(result.current.globalPause?.sourceSessionId).toBe("opencode-session-42");
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

      expect(result.current.globalPause?.reason).toBe("API quota exhausted");
      expect(result.current.globalPause?.sourceSessionId).toBe("codex-worker-99");
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

    it("swallows refresh fetch JSON failures without resetting sessions", async () => {
      const sessions = makeSessions(1);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
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

        await Promise.resolve();
      });

      expect(result.current.sessions).toHaveLength(1);
      expect(result.current.sessions[0].id).toBe("session-0");
    });
  });
});

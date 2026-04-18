import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();
const s1 = { id: "s1", projectId: "proj", lastActivityAt: now } as unknown as DashboardSession;

describe("useSessionEvents - mux", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [s1] }),
      } as unknown as Response),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  it("triggers refresh when mux patch contains unknown id", async () => {
    const initialSessions = [s1];
    const muxSessions = [
      { id: "s1", status: "working", activity: "active", attentionLevel: "working" as const, lastActivityAt: now },
      { id: "s2", status: "working", activity: "active", attentionLevel: "working" as const, lastActivityAt: now },
    ];
    renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions?project=proj",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});

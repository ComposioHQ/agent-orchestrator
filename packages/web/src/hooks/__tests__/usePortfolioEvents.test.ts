import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePortfolioEvents } from "../usePortfolioEvents";
import type { PortfolioActionItem, PortfolioProjectSummary } from "@/lib/types";
import { makeSession } from "../../__tests__/helpers";

function makeActionItem(overrides: Partial<PortfolioActionItem> = {}): PortfolioActionItem {
  return {
    session: makeSession(),
    projectId: "proj-1",
    projectName: "Project 1",
    attentionLevel: "working",
    triageRank: 4,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<PortfolioProjectSummary> = {}): PortfolioProjectSummary {
  return {
    id: "proj-1",
    name: "Project 1",
    sessionCount: 1,
    activeCount: 1,
    attentionCounts: {
      merge: 0,
      respond: 0,
      review: 0,
      pending: 0,
      working: 1,
      done: 0,
    },
    ...overrides,
  };
}

describe("usePortfolioEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [] }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("returns initial state", () => {
    const items = [makeActionItem()];
    const summaries = [makeSummary()];

    const { result } = renderHook(() =>
      usePortfolioEvents(items, summaries),
    );

    expect(result.current.actionItems).toEqual(items);
    expect(result.current.projectSummaries).toEqual(summaries);
  });

  it("polls for updates on interval", async () => {
    renderHook(() =>
      usePortfolioEvents([], [makeSummary()]),
    );

    expect(global.fetch).not.toHaveBeenCalled();

    // Advance past the 5s poll interval
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions?scope=portfolio");
  });

  it("updates state when API returns pre-built actionItems", async () => {
    const updatedItems = [
      makeActionItem({
        attentionLevel: "respond",
        triageRank: 0,
        session: makeSession({ id: "new-session" }),
      }),
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        actionItems: updatedItems,
        projectSummaries: [{ id: "proj-1", name: "Project 1" }],
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      usePortfolioEvents([], [makeSummary()]),
    );

    // Advance timer and flush microtasks
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.actionItems).toEqual(updatedItems);
  });

  it("builds action items from sessions fallback", async () => {
    const session = makeSession({ id: "s1", projectId: "proj-1", status: "working" });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [session],
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() =>
      usePortfolioEvents([], [makeSummary()]),
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.actionItems.length).toBe(1);
    expect(result.current.actionItems[0].session.id).toBe("s1");
  });

  it("handles fetch errors gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error")) as unknown as typeof fetch;

    const items = [makeActionItem()];
    const summaries = [makeSummary()];

    const { result } = renderHook(() =>
      usePortfolioEvents(items, summaries),
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    // State should remain unchanged after error
    expect(result.current.actionItems).toEqual(items);
    expect(result.current.projectSummaries).toEqual(summaries);
  });

  it("handles non-ok response by skipping update", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
    }) as unknown as typeof fetch;

    const items = [makeActionItem()];
    const { result } = renderHook(() =>
      usePortfolioEvents(items, [makeSummary()]),
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.actionItems).toEqual(items);
  });

  it("cleans up interval on unmount", () => {
    const { unmount } = renderHook(() =>
      usePortfolioEvents([], []),
    );

    unmount();

    // Advance timer — fetch should not be called after unmount
    vi.advanceTimersByTime(10000);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { useMediaQuery, useIsMobile } from "../useMediaQuery";

// Track listeners registered via addEventListener
let listeners: Map<string, ((e: MediaQueryListEvent) => void)[]>;
let currentMatches: boolean;

function createMockMql(query: string): MediaQueryList {
  return {
    matches: currentMatches,
    media: query,
    onchange: null,
    addEventListener: (event: string, handler: (e: MediaQueryListEvent) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    removeEventListener: (event: string, handler: (e: MediaQueryListEvent) => void) => {
      const list = listeners.get(event) ?? [];
      listeners.set(
        event,
        list.filter((h) => h !== handler),
      );
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
}

beforeEach(() => {
  listeners = new Map();
  currentMatches = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn(createMockMql),
  });
});

describe("useMediaQuery", () => {
  it("returns false during initial render (SSR-safe default)", () => {
    // matchMedia will return matches=false
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    // After the effect runs it reads the mql — still false
    expect(result.current).toBe(false);
  });

  it("returns true when the media query matches", () => {
    currentMatches = true;
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query match changes", () => {
    currentMatches = false;
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);

    // Simulate a viewport change
    act(() => {
      const changeHandlers = listeners.get("change") ?? [];
      for (const handler of changeHandlers) {
        handler({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(result.current).toBe(true);
  });

  it("cleans up the event listener on unmount", () => {
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect((listeners.get("change") ?? []).length).toBe(1);

    unmount();
    expect((listeners.get("change") ?? []).length).toBe(0);
  });
});

describe("useIsMobile", () => {
  it("queries the md breakpoint (max-width: 767px)", () => {
    renderHook(() => useIsMobile());
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  });

  it("returns true when viewport is below 768px", () => {
    currentMatches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });
});

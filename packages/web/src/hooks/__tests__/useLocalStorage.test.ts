import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLocalStorage } from "@/hooks/useLocalStorage";

describe("useLocalStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("returns default value on initial render", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", 42));
    expect(result.current[0]).toBe(42);
  });

  it("reads stored value from localStorage after mount", async () => {
    localStorage.setItem("test-key", JSON.stringify(99));
    const { result } = renderHook(() => useLocalStorage("test-key", 42));
    // After useEffect runs, value should be from localStorage
    await vi.waitFor(() => {
      expect(result.current[0]).toBe(99);
    });
  });

  it("persists value to localStorage when set", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", 42));
    act(() => {
      result.current[1](100);
    });
    expect(result.current[0]).toBe(100);
    expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(100);
  });

  it("supports updater function", () => {
    const { result } = renderHook(() => useLocalStorage("test-key", 10));
    act(() => {
      result.current[1]((prev) => prev + 5);
    });
    expect(result.current[0]).toBe(15);
    expect(JSON.parse(localStorage.getItem("test-key")!)).toBe(15);
  });

  it("handles boolean values", async () => {
    localStorage.setItem("bool-key", JSON.stringify(true));
    const { result } = renderHook(() => useLocalStorage("bool-key", false));
    await vi.waitFor(() => {
      expect(result.current[0]).toBe(true);
    });
  });

  it("handles invalid JSON gracefully", async () => {
    localStorage.setItem("bad-key", "not-json");
    const { result } = renderHook(() => useLocalStorage("bad-key", "fallback"));
    // Should keep default when JSON parse fails
    await vi.waitFor(() => {
      expect(result.current[0]).toBe("fallback");
    });
  });

  it("handles localStorage getItem throwing", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Access denied");
    });
    const { result } = renderHook(() => useLocalStorage("err-key", 7));
    // Should keep default
    await vi.waitFor(() => {
      expect(result.current[0]).toBe(7);
    });
  });

  it("handles localStorage setItem throwing", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    const { result } = renderHook(() => useLocalStorage("quota-key", 1));
    // Should still update state even if localStorage write fails
    act(() => {
      result.current[1](2);
    });
    expect(result.current[0]).toBe(2);
  });
});

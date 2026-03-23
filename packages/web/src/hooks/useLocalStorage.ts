"use client";

import { useState, useEffect, useCallback } from "react";

/**
 * SSR-safe localStorage hook. Returns the default value during SSR and
 * hydration, then syncs with localStorage in a useEffect to avoid
 * hydration mismatches.
 */
export function useLocalStorage<T>(key: string, defaultValue: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  // Sync from localStorage after mount (SSR-safe)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored);
        // Runtime type check: only accept values whose type matches the default
        if (typeof parsed === typeof defaultValue) {
          setValue(parsed as T);
        }
      }
    } catch {
      // Ignore parse errors or missing localStorage
    }
  }, [key, defaultValue]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // Ignore quota errors
        }
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

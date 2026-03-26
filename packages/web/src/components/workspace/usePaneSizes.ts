"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY_PREFIX = "ao:workspace:panes:";

interface PaneSizesState {
  sizes: number[];
  collapsed: boolean[];
}

export function usePaneSizes(sessionId: string, defaultSizes: number[]) {
  const [state, setState] = useState<PaneSizesState>({
    sizes: defaultSizes,
    collapsed: Array(defaultSizes.length).fill(false),
  });
  const [isHydrated, setIsHydrated] = useState(false);

  // Load from localStorage on mount
  useEffect(() => {
    const storageKey = STORAGE_KEY_PREFIX + sessionId;
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as PaneSizesState;
        setState(parsed);
      }
    } catch (e) {
      console.error("Failed to load pane sizes from localStorage:", e);
    }
    setIsHydrated(true);
  }, [sessionId]);

  const setSizes = useCallback(
    (newSizes: number[]) => {
      setState((prev) => {
        const updated = { ...prev, sizes: newSizes };
        const storageKey = STORAGE_KEY_PREFIX + sessionId;
        try {
          localStorage.setItem(storageKey, JSON.stringify(updated));
        } catch (e) {
          console.error("Failed to save pane sizes to localStorage:", e);
        }
        return updated;
      });
    },
    [sessionId]
  );

  const toggleCollapsed = useCallback(
    (index: number) => {
      setState((prev) => {
        const updated = {
          ...prev,
          collapsed: prev.collapsed.map((c, i) => (i === index ? !c : c)),
        };
        const storageKey = STORAGE_KEY_PREFIX + sessionId;
        try {
          localStorage.setItem(storageKey, JSON.stringify(updated));
        } catch (e) {
          console.error("Failed to save pane state to localStorage:", e);
        }
        return updated;
      });
    },
    [sessionId]
  );

  return {
    sizes: state.sizes,
    collapsed: state.collapsed,
    setSizes,
    toggleCollapsed,
    isHydrated,
  };
}

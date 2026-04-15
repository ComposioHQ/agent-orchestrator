"use client";

import { useState, useCallback, useEffect } from "react";

const STORAGE_KEY_PREFIX = "ao:workspace:panes:";

interface PaneSizesState {
  sizes: number[];
  collapsed: boolean[];
  verticalLayout?: boolean;
  verticalSplit?: [number, number];
  previewFontSize?: number;
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

  const setVerticalLayout = useCallback(
    (vertical: boolean) => {
      setState((prev) => {
        const updated = { ...prev, verticalLayout: vertical };
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

  const setVerticalSplit = useCallback(
    (split: [number, number]) => {
      setState((prev) => {
        const updated = { ...prev, verticalSplit: split };
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

  const setPreviewFontSize = useCallback(
    (fontSize: number) => {
      setState((prev) => {
        const updated = { ...prev, previewFontSize: fontSize };
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
    verticalLayout: state.verticalLayout ?? false,
    verticalSplit: state.verticalSplit ?? [60, 40],
    previewFontSize: state.previewFontSize ?? 13,
    setSizes,
    toggleCollapsed,
    setVerticalLayout,
    setVerticalSplit,
    setPreviewFontSize,
    isHydrated,
  };
}

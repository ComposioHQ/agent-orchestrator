"use client";

import { useCallback, useEffect, useState } from "react";

const SHOW_KILLED_KEY = "ao-show-killed-sessions";
const LEGACY_SHOW_DONE_KEY = "ao-show-done";
const CHANGED = "ao-show-killed-sessions-changed";

export function useShowKilledSessions(): readonly [boolean, (next: boolean) => void] {
  const [showKilled, setShowKilledState] = useState(false);

  useEffect(() => {
    const read = () => {
      try {
        if (
          typeof window !== "undefined" &&
          localStorage.getItem(SHOW_KILLED_KEY) === null &&
          localStorage.getItem(LEGACY_SHOW_DONE_KEY) === "true"
        ) {
          localStorage.setItem(SHOW_KILLED_KEY, "true");
        }
      } catch {
        /* ignore */
      }
      setShowKilledState(
        typeof window !== "undefined" && localStorage.getItem(SHOW_KILLED_KEY) === "true",
      );
    };
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === SHOW_KILLED_KEY) read();
    };
    const onCustom = () => read();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGED, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGED, onCustom);
    };
  }, []);

  const setShowKilled = useCallback((next: boolean) => {
    localStorage.setItem(SHOW_KILLED_KEY, String(next));
    setShowKilledState(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return [showKilled, setShowKilled] as const;
}

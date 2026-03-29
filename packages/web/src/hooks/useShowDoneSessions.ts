"use client";

import { useCallback, useEffect, useState } from "react";

const SHOW_DONE_SIDEBAR_KEY = "ao-show-done-sessions-sidebar";
const CHANGED = "ao-show-done-sessions-sidebar-changed";

/** When false (default), hide non-killed sessions whose attention level is "done" (merged, terminated, etc.). */
export function useShowDoneSessions(): readonly [boolean, (next: boolean) => void] {
  const [showDone, setShowDoneState] = useState(false);

  useEffect(() => {
    const read = () => {
      setShowDoneState(
        typeof window !== "undefined" && localStorage.getItem(SHOW_DONE_SIDEBAR_KEY) === "true",
      );
    };
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === SHOW_DONE_SIDEBAR_KEY) read();
    };
    const onCustom = () => read();
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGED, onCustom);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGED, onCustom);
    };
  }, []);

  const setShowDone = useCallback((next: boolean) => {
    localStorage.setItem(SHOW_DONE_SIDEBAR_KEY, String(next));
    setShowDoneState(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return [showDone, setShowDone] as const;
}

"use client";

import { useCallback, useEffect, useState } from "react";

const SHOW_DONE_KEY = "ao-show-done";
const CHANGED = "ao-show-done-changed";

export function useShowDone(): readonly [boolean, (next: boolean) => void] {
  const [showDone, setShowDoneState] = useState(false);

  useEffect(() => {
    const read = () => setShowDoneState(localStorage.getItem(SHOW_DONE_KEY) === "true");
    read();
    const onStorage = (e: StorageEvent) => {
      if (e.key === SHOW_DONE_KEY) read();
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
    localStorage.setItem(SHOW_DONE_KEY, String(next));
    setShowDoneState(next);
    window.dispatchEvent(new Event(CHANGED));
  }, []);

  return [showDone, setShowDone] as const;
}

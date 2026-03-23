"use client";

import { useState, useEffect } from "react";

/**
 * SSR-safe hook that tracks whether a CSS media query matches.
 * Returns `false` during SSR and hydration, then syncs with the
 * actual viewport in a useEffect to avoid hydration mismatches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** Convenience: true when viewport is below 768px (Tailwind `md` breakpoint). */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

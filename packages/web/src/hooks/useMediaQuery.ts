"use client";

import { useEffect, useState } from "react";

/**
 * Returns a CSS media query string for a max-width breakpoint.
 * e.g. toQuery(767) => "(max-width: 767px)"
 */
function toQuery(queryOrBreakpoint: string | number): string {
  if (typeof queryOrBreakpoint === "number") {
    return `(max-width: ${queryOrBreakpoint}px)`;
  }
  return queryOrBreakpoint;
}

/**
 * Detects whether the current viewport matches a media query.
 *
 * Accepts either a raw query string or a pixel breakpoint number (convenience API).
 * When a number is provided it is treated as a max-width breakpoint, so
 * `useMediaQuery(767)` returns `true` when the viewport width is ≤ 767 px.
 *
 * SSR-safe: returns `false` on the server and hydrates on the client after mount.
 *
 * @example
 * const isMobile = useMediaQuery(767)      // true when width <= 767px
 * const isSmall  = useMediaQuery(640)      // true when width <= 640px
 * const isCustom = useMediaQuery('(max-width: 767px)') // raw query string
 */
export function useMediaQuery(queryOrBreakpoint: string | number): boolean {
  const query = toQuery(queryOrBreakpoint);

  const [matches, setMatches] = useState<boolean>(() => {
    // SSR safety: window is not available on the server.
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQueryList = window.matchMedia(query);

    // Sync state in case the query string changed between renders.
    setMatches(mediaQueryList.matches);

    const listener = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    mediaQueryList.addEventListener("change", listener);

    return () => {
      mediaQueryList.removeEventListener("change", listener);
    };
  }, [query]);

  return matches;
}

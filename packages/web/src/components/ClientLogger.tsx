"use client";

import { useEffect } from "react";
import { initClientLogger } from "@/lib/client-logger";

/** Invisible component that initializes browser-side error/perf capture. */
export function ClientLogger() {
  useEffect(() => {
    const cleanup = initClientLogger();
    return cleanup;
  }, []);

  return null;
}

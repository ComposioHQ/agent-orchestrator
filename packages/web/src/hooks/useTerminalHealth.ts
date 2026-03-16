"use client";

import { useEffect, useState } from "react";
import type { TerminalTransportHealth } from "@/lib/types";

const REFRESH_INTERVAL_MS = 5_000;

let sharedTerminalHealth: TerminalTransportHealth | null = null;
let refreshPromise: Promise<void> | null = null;
let refreshInterval: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<(next: TerminalTransportHealth | null) => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber(sharedTerminalHealth);
  }
}

async function refreshTerminalHealth(): Promise<void> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/terminal-health");
      if (!res.ok) {
        return;
      }
      const next = (await res.json()) as TerminalTransportHealth;
      sharedTerminalHealth = next;
      notifySubscribers();
    } catch {
      return;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function ensureSharedPolling(): void {
  if (refreshInterval) {
    return;
  }

  void refreshTerminalHealth();
  refreshInterval = setInterval(() => {
    void refreshTerminalHealth();
  }, REFRESH_INTERVAL_MS);
}

function stopSharedPollingIfUnused(): void {
  if (subscribers.size > 0 || !refreshInterval) {
    return;
  }
  clearInterval(refreshInterval);
  refreshInterval = null;
}

export function useTerminalHealth(initialHealth: TerminalTransportHealth | null = null): {
  terminalHealth: TerminalTransportHealth | null;
} {
  const [terminalHealth, setTerminalHealth] = useState<TerminalTransportHealth | null>(
    initialHealth ?? sharedTerminalHealth,
  );

  useEffect(() => {
    if (initialHealth && !sharedTerminalHealth) {
      sharedTerminalHealth = initialHealth;
    }

    const subscriber = (next: TerminalTransportHealth | null) => {
      setTerminalHealth(next);
    };
    subscribers.add(subscriber);

    if (sharedTerminalHealth) {
      setTerminalHealth(sharedTerminalHealth);
    }

    ensureSharedPolling();

    return () => {
      subscribers.delete(subscriber);
      stopSharedPollingIfUnused();
    };
  }, [initialHealth]);

  return { terminalHealth };
}

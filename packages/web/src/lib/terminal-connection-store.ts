"use client";

/**
 * Shared connection-status store for terminals.
 *
 * DirectTerminal publishes its current WebSocket connection status here so
 * that other UI components (like CompactTopBar) can show a global
 * reconnection indicator without prop-drilling.
 *
 * Each terminal registers under a unique key (e.g. sessionId+tab) and
 * publishes an entry. Subscribers see the aggregated state across all
 * registered terminals.
 */

import { useSyncExternalStore } from "react";

export type ConnectionStatus = "connecting" | "connected" | "error";

export interface TerminalConnectionState {
  status: ConnectionStatus;
  /** 0 for the initial connect; >=1 for retries */
  attempt: number;
  /** Optional human-readable error message */
  error?: string | null;
}

const entries = new Map<string, TerminalConnectionState>();
const listeners = new Set<() => void>();

let snapshotCache: ReadonlyMap<string, TerminalConnectionState> = entries;

function updateSnapshot(): void {
  // Create a new readonly snapshot reference so React detects the change
  snapshotCache = new Map(entries);
  for (const listener of listeners) listener();
}

export function setTerminalConnection(key: string, state: TerminalConnectionState): void {
  entries.set(key, state);
  updateSnapshot();
}

export function clearTerminalConnection(key: string): void {
  if (entries.delete(key)) updateSnapshot();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ReadonlyMap<string, TerminalConnectionState> {
  return snapshotCache;
}

function getServerSnapshot(): ReadonlyMap<string, TerminalConnectionState> {
  return snapshotCache;
}

export interface AggregatedConnectionStatus {
  /** True if any terminal is in "connecting" state */
  reconnecting: boolean;
  /** Highest attempt number across reconnecting terminals */
  attempt: number;
  /** True if any terminal is in permanent error state */
  hasError: boolean;
}

/**
 * React hook that returns the aggregated connection status across all
 * registered terminals. Re-renders when any terminal's state changes.
 */
export function useAggregatedTerminalConnection(): AggregatedConnectionStatus {
  const map = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  let reconnecting = false;
  let attempt = 0;
  let hasError = false;
  for (const state of map.values()) {
    if (state.status === "connecting") {
      reconnecting = true;
      if (state.attempt > attempt) attempt = state.attempt;
    } else if (state.status === "error") {
      hasError = true;
    }
  }
  return { reconnecting, attempt, hasError };
}

"use client";

/** Persisted per parent AO session — which terminal tab (primary or `-tN`) was last active. */
export interface SessionTerminalTabState {
  subSessionId: string;
  updatedAt: number;
}

function getStorageKey(parentSessionId: string): string {
  return `workspace:active-terminal-tab:${parentSessionId}`;
}

export function loadSessionTerminalTabState(parentSessionId: string): SessionTerminalTabState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(parentSessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionTerminalTabState>;
    if (typeof parsed.subSessionId !== "string" || parsed.subSessionId.length === 0) {
      return null;
    }
    return {
      subSessionId: parsed.subSessionId,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveSessionTerminalTabState(parentSessionId: string, subSessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    const state: SessionTerminalTabState = {
      subSessionId,
      updatedAt: Date.now(),
    };
    window.sessionStorage.setItem(getStorageKey(parentSessionId), JSON.stringify(state));
  } catch {
    // ignore storage write failures
  }
}

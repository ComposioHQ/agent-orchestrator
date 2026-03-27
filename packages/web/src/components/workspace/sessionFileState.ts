"use client";

export interface SessionFileState {
  filePath: string;
  scrollTop: number;
  updatedAt: number;
}

function getStorageKey(sessionId: string): string {
  return `workspace:last-opened:${sessionId}`;
}

export function loadSessionFileState(sessionId: string): SessionFileState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(getStorageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionFileState>;
    if (
      typeof parsed.filePath !== "string" ||
      parsed.filePath.length === 0 ||
      typeof parsed.scrollTop !== "number" ||
      Number.isNaN(parsed.scrollTop)
    ) {
      return null;
    }
    return {
      filePath: parsed.filePath,
      scrollTop: Math.max(0, parsed.scrollTop),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveSessionFileState(sessionId: string, state: SessionFileState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify(state));
  } catch {
    // ignore storage write failures
  }
}

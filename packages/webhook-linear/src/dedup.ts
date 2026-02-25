import type { SpawnType } from "./types.js";

const DEDUP_WINDOW_MS = 5 * 60 * 1000;

const recentSpawns = new Map<string, number>();

function dedupKey(issueId: string, type: SpawnType): string {
  return `${issueId}:${type}`;
}

export function wasRecentlySpawned(issueId: string, type: SpawnType): boolean {
  const key = dedupKey(issueId, type);
  const lastSpawn = recentSpawns.get(key);
  if (!lastSpawn) return false;
  if (Date.now() - lastSpawn > DEDUP_WINDOW_MS) {
    recentSpawns.delete(key);
    return false;
  }
  return true;
}

export function markSpawned(issueId: string, type: SpawnType): void {
  recentSpawns.set(dedupKey(issueId, type), Date.now());
}

export function cleanup(): void {
  const now = Date.now();
  for (const [key, timestamp] of recentSpawns) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentSpawns.delete(key);
    }
  }
}

export function reset(): void {
  recentSpawns.clear();
}

export function entries(): ReadonlyMap<string, number> {
  return recentSpawns;
}

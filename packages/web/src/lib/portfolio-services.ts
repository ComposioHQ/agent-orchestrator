/**
 * Portfolio services — cached singleton for the web server.
 *
 * Follows the same globalThis caching pattern as services.ts:
 * - Portfolio data is cached in memory with a TTL
 * - Background refresh keeps data fresh without blocking requests
 * - Filesystem I/O happens on the refresh timer, not on request path
 */

import {
  getPortfolio,
  listPortfolioSessions,
  getPortfolioSessionCounts,
  loadConfig,
  generateSessionPrefix,
  type PortfolioProject,
  type PortfolioPreferences,
  type PortfolioSession,
  loadPreferences,
} from "@composio/ao-core";

export interface PortfolioServices {
  portfolio: PortfolioProject[];
  preferences: PortfolioPreferences;
}

interface CachedPortfolio {
  services: PortfolioServices;
  sessions: PortfolioSession[];
  refreshedAt: number;
}

const CACHE_TTL_MS = 10_000; // 10 seconds
const BACKGROUND_REFRESH_MS = 15_000; // 15 seconds

// Cache in globalThis to survive Next.js HMR reloads (same pattern as services.ts)
const globalForPortfolio = globalThis as typeof globalThis & {
  _aoPortfolioCache?: CachedPortfolio;
  _aoPortfolioRefreshTimer?: ReturnType<typeof setInterval>;
};

function isCacheFresh(): boolean {
  const cached = globalForPortfolio._aoPortfolioCache;
  if (!cached) return false;
  return Date.now() - cached.refreshedAt < CACHE_TTL_MS;
}

function refreshCache(): CachedPortfolio {
  let portfolio = getPortfolio();
  if (portfolio.length === 0) {
    try {
      const config = loadConfig();
      portfolio = Object.entries(config.projects).map(([id, project]) => ({
        id,
        name: project.name ?? id,
        configPath: config.configPath,
        configProjectKey: id,
        repoPath: project.path,
        repo: project.repo,
        defaultBranch: project.defaultBranch,
        sessionPrefix: project.sessionPrefix ?? generateSessionPrefix(id),
        source: "config" as const,
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
      }));
    } catch {
      // No local config available — keep the portfolio empty.
    }
  }
  const preferences = loadPreferences();
  const cached: CachedPortfolio = {
    services: { portfolio, preferences },
    sessions: [], // Sessions are loaded async — populated by refreshSessionsCache()
    refreshedAt: Date.now(),
  };
  globalForPortfolio._aoPortfolioCache = cached;
  return cached;
}

async function refreshSessionsCache(): Promise<void> {
  const cached = globalForPortfolio._aoPortfolioCache;
  if (!cached) return;
  try {
    const sessions = await listPortfolioSessions(cached.services.portfolio);
    cached.sessions = sessions;
    cached.refreshedAt = Date.now();
  } catch {
    // Keep stale sessions on refresh failure
  }
}

// Start background refresh timer (idempotent)
function ensureBackgroundRefresh(): void {
  if (globalForPortfolio._aoPortfolioRefreshTimer) return;
  globalForPortfolio._aoPortfolioRefreshTimer = setInterval(() => {
    try {
      refreshCache();
      void refreshSessionsCache();
    } catch {
      // Background refresh failure is non-fatal
    }
  }, BACKGROUND_REFRESH_MS);
}

/** Get portfolio services (cached, non-blocking after first call). */
export function getPortfolioServices(): PortfolioServices {
  ensureBackgroundRefresh();
  if (isCacheFresh()) {
    return globalForPortfolio._aoPortfolioCache!.services;
  }
  return refreshCache().services;
}

/** Get cached portfolio sessions. First call triggers async load. */
export async function getCachedPortfolioSessions(): Promise<PortfolioSession[]> {
  ensureBackgroundRefresh();
  const cached = globalForPortfolio._aoPortfolioCache;
  if (cached && cached.sessions.length > 0 && isCacheFresh()) {
    return cached.sessions;
  }
  // Cache miss or stale — refresh synchronously
  if (!cached || !isCacheFresh()) {
    refreshCache();
  }
  await refreshSessionsCache();
  return globalForPortfolio._aoPortfolioCache?.sessions ?? [];
}

// Re-export for direct use when cache bypass is needed
export { listPortfolioSessions, getPortfolioSessionCounts };
export type { PortfolioProject, PortfolioSession };

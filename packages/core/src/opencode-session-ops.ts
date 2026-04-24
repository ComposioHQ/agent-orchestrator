/**
 * OpenCode-specific session operations.
 *
 * Extracted from session-manager.ts. OpenCode plumbing (session discovery by
 * title, CLI-driven deletion, metadata mapping) does not belong in the generic
 * session manager; these helpers are siloed here so they can be reasoned about
 * and tested independently.
 */

import { existsSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  listMetadata,
  readArchivedMetadataRaw,
  readMetadataRaw,
  updateArchivedMetadata,
  updateMetadata,
} from "./metadata.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";
import type { Session, SessionId } from "./types.js";
import { safeJsonParse } from "./utils/validation.js";

const execFileAsync = promisify(execFile);

export const OPENCODE_DISCOVERY_TIMEOUT_MS = 10_000;
export const OPENCODE_INTERACTIVE_DISCOVERY_TIMEOUT_MS = 10_000;

function errorIncludesSessionNotFound(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { stderr?: string; stdout?: string };
  const combined = [err.message, e.stderr, e.stdout].filter(Boolean).join("\n");
  return /session not found/i.test(combined);
}

export async function deleteOpenCodeSession(sessionId: string): Promise<void> {
  const validatedSessionId = asValidOpenCodeSessionId(sessionId);
  if (!validatedSessionId) return;
  const retryDelaysMs = [0, 200, 600];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      await execFileAsync("opencode", ["session", "delete", validatedSessionId], {
        timeout: 30_000,
      });
      return;
    } catch (err) {
      if (errorIncludesSessionNotFound(err)) {
        return;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  updatedAt?: number;
}

export async function fetchOpenCodeSessionList(
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
): Promise<OpenCodeSessionListEntry[]> {
  try {
    const { stdout } = await execFileAsync("opencode", ["session", "list", "--format", "json"], {
      timeout: timeoutMs,
    });
    const parsed = safeJsonParse<unknown>(stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const title = typeof entry["title"] === "string" ? entry["title"] : "";
      const id = asValidOpenCodeSessionId(entry["id"]);
      if (!id) return [];
      const rawUpdated = entry["updated"];
      let updatedAt: number | undefined;
      if (typeof rawUpdated === "number" && Number.isFinite(rawUpdated)) {
        updatedAt = rawUpdated;
      } else if (typeof rawUpdated === "string") {
        const parsedUpdated = Date.parse(rawUpdated);
        if (!Number.isNaN(parsedUpdated)) {
          updatedAt = parsedUpdated;
        }
      }
      return [{ id, title, ...(updatedAt !== undefined ? { updatedAt } : {}) }];
    });
  } catch {
    return [];
  }
}

export async function discoverOpenCodeSessionIdsByTitle(
  sessionId: string,
  timeoutMs = OPENCODE_DISCOVERY_TIMEOUT_MS,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string[]> {
  const sessions = await (sessionListPromise ?? fetchOpenCodeSessionList(timeoutMs));
  const title = `AO:${sessionId}`;
  return sessions
    .filter((entry) => entry.title === title)
    .sort((a, b) => {
      const ta = a.updatedAt ?? -Infinity;
      const tb = b.updatedAt ?? -Infinity;
      if (ta === tb) return 0;
      return tb - ta;
    })
    .map((entry) => entry.id);
}

export async function discoverOpenCodeSessionIdByTitle(
  sessionId: string,
  timeoutMs?: number,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<string | undefined> {
  const matches = await discoverOpenCodeSessionIdsByTitle(sessionId, timeoutMs, sessionListPromise);
  return matches[0];
}

function listArchivedSessionIds(sessionsDir: string): string[] {
  const archiveDir = join(sessionsDir, "archive");
  if (!existsSync(archiveDir)) return [];
  const ids = new Set<string>();
  for (const file of readdirSync(archiveDir)) {
    const match = file.match(/^([a-zA-Z0-9_-]+)_\d/);
    if (match?.[1]) ids.add(match[1]);
  }
  return [...ids];
}

function sortSessionIdsForReuse(ids: string[]): string[] {
  const numericSuffix = (id: string): number | undefined => {
    const match = id.match(/-(\d+)$/);
    if (!match) return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  };

  return [...ids].sort((a, b) => {
    const aNum = numericSuffix(a);
    const bNum = numericSuffix(b);
    if (aNum !== undefined && bNum !== undefined && aNum !== bNum) {
      return bNum - aNum;
    }
    if (aNum !== undefined && bNum === undefined) return -1;
    if (aNum === undefined && bNum !== undefined) return 1;
    return b.localeCompare(a);
  });
}

export function findOpenCodeSessionIds(
  sessionsDir: string,
  criteria: { issueId?: string; sessionId?: string },
): string[] {
  const matchesCriteria = (id: string, raw: Record<string, string> | null): boolean => {
    if (!raw) return false;
    if (raw["agent"] !== "opencode") return false;
    if (criteria.issueId !== undefined && raw["issue"] !== criteria.issueId) return false;
    if (criteria.sessionId !== undefined && id !== criteria.sessionId) return false;
    return true;
  };

  const ids: string[] = [];
  const maybeAdd = (id: string, raw: Record<string, string> | null) => {
    if (!matchesCriteria(id, raw)) return;
    const mapped = asValidOpenCodeSessionId(raw?.["opencodeSessionId"]);
    if (!mapped) return;
    ids.push(mapped);
  };

  for (const id of sortSessionIdsForReuse(listMetadata(sessionsDir))) {
    maybeAdd(id, readMetadataRaw(sessionsDir, id));
  }
  for (const id of sortSessionIdsForReuse(listArchivedSessionIds(sessionsDir))) {
    maybeAdd(id, readArchivedMetadataRaw(sessionsDir, id));
  }

  if (criteria.sessionId) {
    maybeAdd(criteria.sessionId, readArchivedMetadataRaw(sessionsDir, criteria.sessionId));
  }

  return [...new Set(ids)];
}

export async function resolveOpenCodeSessionReuse(options: {
  sessionsDir: string;
  criteria: { issueId?: string; sessionId?: string };
  strategy: "reuse" | "delete" | "ignore";
  includeTitleDiscoveryForSessionId?: boolean;
}): Promise<string | undefined> {
  const { sessionsDir, criteria, strategy, includeTitleDiscoveryForSessionId = false } = options;
  if (strategy === "ignore") return undefined;

  let candidateIds = findOpenCodeSessionIds(sessionsDir, criteria);

  if (strategy === "delete") {
    if (includeTitleDiscoveryForSessionId && criteria.sessionId) {
      candidateIds = [
        ...candidateIds,
        ...(await discoverOpenCodeSessionIdsByTitle(criteria.sessionId)),
      ];
    }

    for (const openCodeSessionId of [...new Set(candidateIds)]) {
      await deleteOpenCodeSession(openCodeSessionId);
    }
    return undefined;
  }

  if (candidateIds.length === 0 && criteria.sessionId) {
    candidateIds = await discoverOpenCodeSessionIdsByTitle(criteria.sessionId);
  }

  return candidateIds[0];
}

export async function ensureOpenCodeSessionMapping(
  session: Session,
  sessionName: string,
  sessionsDir: string,
  effectiveAgentName: string,
  sessionListPromise?: Promise<OpenCodeSessionListEntry[]>,
): Promise<void> {
  if (effectiveAgentName !== "opencode") return;
  if (asValidOpenCodeSessionId(session.metadata["opencodeSessionId"])) return;

  const discovered = await discoverOpenCodeSessionIdByTitle(
    sessionName,
    OPENCODE_DISCOVERY_TIMEOUT_MS,
    sessionListPromise,
  );
  if (!discovered) return;

  session.metadata["opencodeSessionId"] = discovered;
  updateMetadata(sessionsDir, sessionName, { opencodeSessionId: discovered });
}

export function markArchivedOpenCodeCleanup(sessionsDir: string, sessionId: SessionId): void {
  updateArchivedMetadata(sessionsDir, sessionId, {
    opencodeSessionId: "",
    opencodeCleanedAt: new Date().toISOString(),
  });
}

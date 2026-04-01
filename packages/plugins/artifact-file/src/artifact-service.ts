/**
 * File-based ArtifactService implementation.
 *
 * Stores artifacts in a per-session directory structure:
 *   artifacts/
 *   ├── manifest.json
 *   ├── {sessionId}/
 *   │   ├── file.md
 *   │   ├── file.md.meta.json
 *   │   └── ...
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  statSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join, basename, resolve } from "node:path";
import {
  updateMetadata,
  type ArtifactService,
  type ArtifactEntry,
  type ArtifactManifest,
  type ArtifactFilter,
  type ArtifactSearchResult,
  type ArtifactStatus,
  type ArtifactCategory,
} from "@composio/ao-core";
import {
  generateArtifactId,
  detectMimeType,
  isGreppable,
  readManifest,
  writeManifest,
  withManifestLock,
  writeSidecar,
  readSidecar,
  removeSidecar,
} from "./utils.js";
import { validatePublish } from "./guards.js";

export interface ArtifactServiceConfig {
  artifactsDir: string;
  sessionsDir?: string;
  worktreePath?: string;
}

export function createArtifactService(config: ArtifactServiceConfig): ArtifactService {
  const { artifactsDir, sessionsDir, worktreePath } = config;

  function getSessionDir(sessionId: string): string {
    return join(artifactsDir, sessionId);
  }

  function ensureSessionDir(sessionId: string): string {
    const dir = getSessionDir(sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  async function ensureManifest(): Promise<ArtifactManifest> {
    const manifestPath = join(artifactsDir, "manifest.json");
    if (existsSync(manifestPath)) {
      return readManifest(artifactsDir);
    }

    // Check if artifact directories exist (manifest lost but files present)
    if (existsSync(artifactsDir)) {
      const entries = readdirSync(artifactsDir, { withFileTypes: true });
      const hasDirs = entries.some((e) => e.isDirectory());
      if (hasDirs) {
        await service.rebuildManifest();
        return readManifest(artifactsDir);
      }
    }

    return { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: [] };
  }

  function filterEntries(
    entries: ArtifactEntry[],
    filter?: ArtifactFilter,
  ): ArtifactEntry[] {
    if (!filter) return entries.filter((e) => e.status !== "deleted");

    let result = entries;

    // Exclude deleted by default
    if (!filter.includeDeleted) {
      result = result.filter((e) => e.status !== "deleted");
    }

    if (filter.sessionId) {
      result = result.filter((e) => e.sessionId === filter.sessionId);
    }
    if (filter.issueId) {
      result = result.filter((e) => e.issueId === filter.issueId);
    }
    if (filter.category) {
      result = result.filter((e) => e.category === filter.category);
    }
    if (filter.status) {
      result = result.filter((e) => e.status === filter.status);
    }
    if (filter.isReference !== undefined) {
      result = result.filter((e) => Boolean(e.isReference) === filter.isReference);
    }
    if (filter.tags && filter.tags.length > 0) {
      const filterTags = new Set(filter.tags);
      result = result.filter(
        (e) => e.tags && e.tags.some((t) => filterTags.has(t)),
      );
    }
    if (filter.createdAfter) {
      const after = new Date(filter.createdAfter).getTime();
      result = result.filter((e) => new Date(e.createdAt).getTime() >= after);
    }
    if (filter.createdBefore) {
      const before = new Date(filter.createdBefore).getTime();
      result = result.filter((e) => new Date(e.createdAt).getTime() <= before);
    }
    if (filter.lastN !== undefined && filter.lastN > 0) {
      // Get unique session IDs sorted by most recent artifact (from filtered results)
      const sessionLastActivity = new Map<string, number>();
      for (const e of result) {
        const t = new Date(e.createdAt).getTime();
        const existing = sessionLastActivity.get(e.sessionId) ?? 0;
        if (t > existing) sessionLastActivity.set(e.sessionId, t);
      }
      const recentSessions = [...sessionLastActivity.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, filter.lastN)
        .map(([sid]) => sid);
      const sessionSet = new Set(recentSessions);
      result = result.filter((e) => sessionSet.has(e.sessionId));
    }

    return result;
  }

  function resolveEntryId(entries: ArtifactEntry[], artifactId: string): ArtifactEntry | null {
    // Try exact match first
    const exact = entries.find((e) => e.id === artifactId);
    if (exact) return exact;

    // Try prefix match
    const matches = entries.filter((e) => e.id.startsWith(artifactId));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous artifact ID prefix "${artifactId}" matches ${matches.length} entries. Use a longer prefix.`,
      );
    }
    return null;
  }

  function updateSessionMetadata(sessionId: string, manifest: ArtifactManifest): void {
    if (!sessionsDir) return;
    try {
      const sessionEntries = manifest.entries.filter(
        (e) => e.sessionId === sessionId && e.status !== "deleted",
      );
      updateMetadata(sessionsDir, sessionId, {
        artifactCount: String(sessionEntries.length),
        artifactLastAt: new Date().toISOString(),
      });
    } catch {
      // Non-fatal: session metadata sync is best-effort
    }
  }

  const service: ArtifactService = {
    name: "file",

    async init(): Promise<void> {
      if (!existsSync(artifactsDir)) {
        mkdirSync(artifactsDir, { recursive: true });
      }
      const manifestPath = join(artifactsDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        const empty: ArtifactManifest = {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          entries: [],
        };
        writeManifest(artifactsDir, empty);
      }
    },

    async isInitialized(): Promise<boolean> {
      return existsSync(join(artifactsDir, "manifest.json"));
    },

    async publish(
      sessionId: string,
      filePath: string,
      meta: Partial<ArtifactEntry>,
    ): Promise<ArtifactEntry> {
      const resolvedPath = resolve(filePath);

      if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Enforce publish guards (sensitive file blocking, path traversal prevention)
      if (worktreePath) {
        validatePublish(resolvedPath, worktreePath);
      }

      const filename = meta.filename ?? basename(resolvedPath);
      const mimeType = meta.mimeType ?? detectMimeType(filename);
      const stat = statSync(resolvedPath);
      const id = generateArtifactId();
      const now = new Date().toISOString();

      // Ensure session artifact directory
      const sessionDir = ensureSessionDir(sessionId);

      // Determine destination — handle filename collisions
      let destFilename = filename;
      let destPath = join(sessionDir, destFilename);
      if (existsSync(destPath)) {
        const ext = destFilename.includes(".")
          ? "." + destFilename.split(".").pop()
          : "";
        const base = ext
          ? destFilename.slice(0, -ext.length)
          : destFilename;
        destFilename = `${base}-${id.slice(0, 8)}${ext}`;
        destPath = join(sessionDir, destFilename);
      }

      // Copy file to artifact store
      copyFileSync(resolvedPath, destPath);

      const entry: ArtifactEntry = {
        id,
        sessionId,
        issueId: meta.issueId,
        filename: destFilename,
        path: `${sessionId}/${destFilename}`,
        mimeType,
        category: meta.category ?? "other",
        status: meta.status ?? "published",
        size: stat.size,
        createdAt: now,
        updatedAt: now,
        description: meta.description,
        tags: meta.tags,
      };

      // Write sidecar metadata
      writeSidecar(destPath, entry);

      // Update manifest atomically
      await withManifestLock(artifactsDir, async () => {
        const manifest = readManifest(artifactsDir);
        manifest.entries.push(entry);
        writeManifest(artifactsDir, manifest);
        updateSessionMetadata(sessionId, manifest);
      });

      return entry;
    },

    async publishReference(
      sessionId: string,
      meta: {
        referenceType: string;
        referenceUrl: string;
        category: ArtifactCategory;
        description: string;
        issueId?: string;
      },
    ): Promise<ArtifactEntry> {
      const id = generateArtifactId();
      const now = new Date().toISOString();
      const filename = `${meta.referenceType}-${id.slice(0, 8)}`;

      const entry: ArtifactEntry = {
        id,
        sessionId,
        issueId: meta.issueId,
        filename,
        path: `${sessionId}/${filename}`,
        mimeType: "application/x-reference",
        category: meta.category,
        status: "published",
        size: 0,
        createdAt: now,
        updatedAt: now,
        description: meta.description,
        isReference: true,
        referenceUrl: meta.referenceUrl,
        referenceType: meta.referenceType,
      };

      // Ensure session dir exists for consistency
      ensureSessionDir(sessionId);

      // Write sidecar for recovery (no actual file for references)
      const sidecarFilePath = join(getSessionDir(sessionId), filename);
      writeSidecar(sidecarFilePath, entry);

      await withManifestLock(artifactsDir, async () => {
        const manifest = readManifest(artifactsDir);
        manifest.entries.push(entry);
        writeManifest(artifactsDir, manifest);
        updateSessionMetadata(sessionId, manifest);
      });

      return entry;
    },

    async list(filter?: ArtifactFilter): Promise<ArtifactEntry[]> {
      const manifest = await ensureManifest();
      return filterEntries(manifest.entries, filter);
    },

    async get(
      artifactId: string,
    ): Promise<{ entry: ArtifactEntry; absolutePath: string | null } | null> {
      const manifest = await ensureManifest();
      const entry = resolveEntryId(manifest.entries, artifactId);
      if (!entry) return null;

      const absolutePath = entry.isReference
        ? null
        : join(artifactsDir, entry.path);

      return { entry, absolutePath };
    },

    async readContent(artifactId: string): Promise<string | null> {
      const result = await service.get(artifactId);
      if (!result || !result.absolutePath) return null;

      if (!isGreppable(result.entry)) return null;

      try {
        return readFileSync(result.absolutePath, "utf-8");
      } catch {
        return null;
      }
    },

    async grep(
      pattern: string,
      filter?: ArtifactFilter,
    ): Promise<ArtifactSearchResult[]> {
      const manifest = await ensureManifest();
      const entries = filterEntries(manifest.entries, filter);
      const greppableEntries = entries.filter(isGreppable);

      const regex = new RegExp(pattern, "gi");
      const results: ArtifactSearchResult[] = [];

      for (const entry of greppableEntries) {
        const filePath = join(artifactsDir, entry.path);
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          continue;
        }

        const lines = content.split("\n");
        const matches: ArtifactSearchResult["matches"] = [];

        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const contextStart = Math.max(0, i - 2);
            const contextEnd = Math.min(lines.length - 1, i + 2);
            matches.push({
              line: i + 1,
              content: lines[i],
              context: lines.slice(contextStart, contextEnd + 1).join("\n"),
            });
          }
          // Reset regex lastIndex since we use 'g' flag
          regex.lastIndex = 0;
        }

        if (matches.length > 0) {
          results.push({ artifact: entry, matches });
        }
      }

      return results;
    },

    async updateStatus(
      artifactId: string,
      status: ArtifactStatus,
    ): Promise<ArtifactEntry> {
      return service.update(artifactId, { status });
    },

    async update(
      artifactId: string,
      updates: { description?: string; tags?: string[]; status?: ArtifactStatus },
    ): Promise<ArtifactEntry> {
      let updated: ArtifactEntry | undefined;

      await withManifestLock(artifactsDir, async () => {
        const manifest = readManifest(artifactsDir);
        const entry = resolveEntryId(manifest.entries, artifactId);
        if (!entry) throw new Error(`Artifact not found: ${artifactId}`);

        if (updates.status !== undefined) entry.status = updates.status;
        if (updates.description !== undefined) entry.description = updates.description;
        if (updates.tags !== undefined) entry.tags = updates.tags;
        entry.updatedAt = new Date().toISOString();

        writeManifest(artifactsDir, manifest);

        // Update sidecar
        const filePath = join(artifactsDir, entry.path);
        writeSidecar(filePath, entry);

        updated = entry;
      });

      if (!updated) throw new Error(`Artifact not found: ${artifactId}`);
      return updated;
    },

    async delete(
      artifactId: string,
      options?: { purge?: boolean; deletedBy?: string },
    ): Promise<void> {
      await withManifestLock(artifactsDir, async () => {
        const manifest = readManifest(artifactsDir);
        const resolved = resolveEntryId(manifest.entries, artifactId);
        if (!resolved) throw new Error(`Artifact not found: ${artifactId}`);
        const idx = manifest.entries.indexOf(resolved);

        const entry = manifest.entries[idx];
        const filePath = join(artifactsDir, entry.path);

        // Remove the actual file
        if (!entry.isReference && existsSync(filePath)) {
          unlinkSync(filePath);
        }

        if (options?.purge) {
          // Hard delete — remove from manifest entirely
          manifest.entries.splice(idx, 1);
          removeSidecar(filePath);
        } else {
          // Tombstone — mark as deleted
          entry.status = "deleted";
          entry.deletedAt = new Date().toISOString();
          entry.deletedBy = options?.deletedBy;
          entry.updatedAt = new Date().toISOString();
          writeSidecar(filePath, entry);
        }

        writeManifest(artifactsDir, manifest);
      });
    },

    async rebuildManifest(): Promise<void> {
      const entries: ArtifactEntry[] = [];

      if (!existsSync(artifactsDir)) return;

      const topLevel = readdirSync(artifactsDir, { withFileTypes: true });
      for (const dir of topLevel) {
        if (!dir.isDirectory()) continue;
        const sessionId = dir.name;
        const sessionDir = join(artifactsDir, sessionId);
        const files = readdirSync(sessionDir);

        for (const file of files) {
          // Skip sidecar files
          if (file.endsWith(".meta.json")) continue;

          const filePath = join(sessionDir, file);
          const sidecar = readSidecar(filePath);

          if (sidecar) {
            entries.push(sidecar);
          } else {
            // Create skeleton entry from filename
            const stat = statSync(filePath);
            entries.push({
              id: generateArtifactId(),
              sessionId,
              filename: file,
              path: `${sessionId}/${file}`,
              mimeType: detectMimeType(file),
              category: "other",
              status: "published",
              size: stat.size,
              createdAt: stat.birthtime.toISOString(),
              updatedAt: stat.mtime.toISOString(),
            });
          }
        }
      }

      const manifest: ArtifactManifest = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        entries,
      };
      writeManifest(artifactsDir, manifest);
    },
  };

  return service;
}

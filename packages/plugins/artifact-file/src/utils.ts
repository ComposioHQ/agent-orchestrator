/**
 * Artifact utilities — atomic writes, file locking, MIME detection, sidecar IO.
 */

import { writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactEntry, ArtifactManifest } from "@composio/ao-core";
import lockfile from "proper-lockfile";

// =============================================================================
// UUID
// =============================================================================

export function generateArtifactId(): string {
  return randomUUID();
}

// =============================================================================
// MIME DETECTION
// =============================================================================

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".log": "text/plain",
  ".ts": "text/typescript",
  ".js": "text/javascript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export function detectMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// =============================================================================
// GREPPABLE CHECK
// =============================================================================

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "text/typescript",
  "text/javascript",
  "text/x-python",
  "text/x-shellscript",
  "text/css",
  "text/x-sql",
  "application/json",
  "application/xml",
  "application/yaml",
]);

export function isGreppable(entry: ArtifactEntry): boolean {
  if (entry.isReference) return false;
  if (entry.status === "deleted") return false;
  return TEXT_MIMES.has(entry.mimeType);
}

// =============================================================================
// ATOMIC WRITES
// =============================================================================

export function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, data, "utf-8");
  renameSync(tmpPath, filePath);
}

// =============================================================================
// FILE LOCKING
// =============================================================================

export async function withManifestLock<T>(
  artifactsDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(artifactsDir, {
      lockfilePath: join(artifactsDir, "manifest.lock"),
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    });
    return await fn();
  } finally {
    if (release) {
      await release();
    }
  }
}

// =============================================================================
// MANIFEST IO
// =============================================================================

export function readManifest(artifactsDir: string): ArtifactManifest {
  const manifestPath = join(artifactsDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as ArtifactManifest;
  } catch {
    return { schemaVersion: 1, updatedAt: new Date().toISOString(), entries: [] };
  }
}

export function writeManifest(artifactsDir: string, manifest: ArtifactManifest): void {
  const manifestPath = join(artifactsDir, "manifest.json");
  manifest.updatedAt = new Date().toISOString();
  atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// =============================================================================
// SIDECAR METADATA
// =============================================================================

export function sidecarPath(artifactFilePath: string): string {
  return `${artifactFilePath}.meta.json`;
}

export function writeSidecar(
  artifactFilePath: string,
  entry: ArtifactEntry,
): void {
  const meta = { ...entry };
  atomicWriteFileSync(sidecarPath(artifactFilePath), JSON.stringify(meta, null, 2));
}

export function readSidecar(artifactFilePath: string): ArtifactEntry | null {
  const path = sidecarPath(artifactFilePath);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as ArtifactEntry;
  } catch {
    return null;
  }
}

export function removeSidecar(artifactFilePath: string): void {
  const path = sidecarPath(artifactFilePath);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best effort
    }
  }
}

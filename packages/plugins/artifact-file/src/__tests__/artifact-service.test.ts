import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ArtifactManifest } from "@composio/ao-core";
import { createArtifactService } from "../artifact-service.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ao-artifact-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeWorktree(baseDir: string): string {
  const dir = join(baseDir, "worktree");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("artifact-service", () => {
  let tmpDir: string;
  let artifactsDir: string;
  let worktreeDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    artifactsDir = join(tmpDir, "artifacts");
    worktreeDir = makeWorktree(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService() {
    return createArtifactService({ artifactsDir });
  }

  function writeTestFile(name: string, content: string): string {
    const filePath = join(worktreeDir, name);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  describe("init", () => {
    it("creates artifacts directory and manifest.json", async () => {
      const service = createService();
      await service.init();

      expect(existsSync(artifactsDir)).toBe(true);
      expect(existsSync(join(artifactsDir, "manifest.json"))).toBe(true);

      const manifest = JSON.parse(
        readFileSync(join(artifactsDir, "manifest.json"), "utf-8"),
      ) as ArtifactManifest;
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.entries).toEqual([]);
    });

    it("isInitialized returns false before init", async () => {
      const service = createService();
      expect(await service.isInitialized()).toBe(false);
    });

    it("isInitialized returns true after init", async () => {
      const service = createService();
      await service.init();
      expect(await service.isInitialized()).toBe(true);
    });
  });

  describe("publish", () => {
    it("copies file and adds manifest entry", async () => {
      const service = createService();
      await service.init();

      const filePath = writeTestFile("design-doc.md", "# Design\n\nSome design doc");
      const entry = await service.publish("ao-1", filePath, {
        category: "document",
        description: "Auth design document",
      });

      expect(entry.id).toBeTruthy();
      expect(entry.sessionId).toBe("ao-1");
      expect(entry.filename).toBe("design-doc.md");
      expect(entry.category).toBe("document");
      expect(entry.status).toBe("published");
      expect(entry.mimeType).toBe("text/markdown");
      expect(entry.size).toBeGreaterThan(0);
      expect(entry.description).toBe("Auth design document");

      // File should be copied to artifacts/ao-1/design-doc.md
      const artifactPath = join(artifactsDir, entry.path);
      expect(existsSync(artifactPath)).toBe(true);
      expect(readFileSync(artifactPath, "utf-8")).toBe("# Design\n\nSome design doc");

      // Sidecar should exist
      expect(existsSync(`${artifactPath}.meta.json`)).toBe(true);
    });

    it("handles filename collisions", async () => {
      const service = createService();
      await service.init();

      const file1 = writeTestFile("report.md", "Report 1");
      const file2 = writeTestFile("report.md", "Report 2");

      const entry1 = await service.publish("ao-1", file1, { category: "document" });
      const entry2 = await service.publish("ao-1", file2, { category: "document" });

      expect(entry1.filename).toBe("report.md");
      expect(entry2.filename).not.toBe("report.md");
      expect(entry2.filename).toContain("report-");
    });

    it("sets issueId when provided", async () => {
      const service = createService();
      await service.init();

      const filePath = writeTestFile("test.md", "content");
      const entry = await service.publish("ao-1", filePath, {
        category: "document",
        issueId: "INT-42",
      });

      expect(entry.issueId).toBe("INT-42");
    });

    it("throws for non-existent file", async () => {
      const service = createService();
      await service.init();

      await expect(
        service.publish("ao-1", "/nonexistent/file.md", { category: "document" }),
      ).rejects.toThrow("File not found");
    });

    it("sets tags when provided", async () => {
      const service = createService();
      await service.init();

      const filePath = writeTestFile("tagged.md", "content");
      const entry = await service.publish("ao-1", filePath, {
        category: "document",
        tags: ["auth", "design"],
      });

      expect(entry.tags).toEqual(["auth", "design"]);
    });
  });

  describe("list", () => {
    it("returns all non-deleted artifacts", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "A");
      const f2 = writeTestFile("b.md", "B");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-2", f2, { category: "test-report" });

      const all = await service.list();
      expect(all.length).toBe(2);
    });

    it("filters by sessionId", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "A");
      const f2 = writeTestFile("b.md", "B");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-2", f2, { category: "document" });

      const filtered = await service.list({ sessionId: "ao-1" });
      expect(filtered.length).toBe(1);
      expect(filtered[0].sessionId).toBe("ao-1");
    });

    it("filters by issueId across sessions", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "A");
      const f2 = writeTestFile("b.md", "B");
      const f3 = writeTestFile("c.md", "C");
      await service.publish("ao-1", f1, { category: "document", issueId: "INT-42" });
      await service.publish("ao-2", f2, { category: "document", issueId: "INT-42" });
      await service.publish("ao-3", f3, { category: "document", issueId: "INT-99" });

      const filtered = await service.list({ issueId: "INT-42" });
      expect(filtered.length).toBe(2);
    });

    it("filters by category", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "A");
      const f2 = writeTestFile("b.png", "not-really-png");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-1", f2, { category: "screenshot" });

      const docs = await service.list({ category: "document" });
      expect(docs.length).toBe(1);
      expect(docs[0].category).toBe("document");
    });

    it("excludes deleted by default", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("a.md", "A");
      const entry = await service.publish("ao-1", f, { category: "document" });
      await service.delete(entry.id);

      const all = await service.list();
      expect(all.length).toBe(0);

      const withDeleted = await service.list({ includeDeleted: true });
      expect(withDeleted.length).toBe(1);
    });
  });

  describe("get", () => {
    it("returns entry and absolute path", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });

      const result = await service.get(entry.id);
      expect(result).not.toBeNull();
      expect(result!.entry.id).toBe(entry.id);
      expect(result!.absolutePath).toBe(join(artifactsDir, entry.path));
    });

    it("returns null for non-existent id", async () => {
      const service = createService();
      await service.init();

      const result = await service.get("nonexistent-id");
      expect(result).toBeNull();
    });
  });

  describe("readContent", () => {
    it("reads text content", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "Hello World");
      const entry = await service.publish("ao-1", f, { category: "document" });

      const content = await service.readContent(entry.id);
      expect(content).toBe("Hello World");
    });

    it("returns null for binary artifacts", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("image.png", "fake-png-data");
      const entry = await service.publish("ao-1", f, { category: "screenshot" });

      const content = await service.readContent(entry.id);
      expect(content).toBeNull();
    });

  });

  describe("grep", () => {
    it("searches across text artifacts", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "Payment gateway integration\nLine 2");
      const f2 = writeTestFile("b.md", "Auth module\nNo payment here");
      const f3 = writeTestFile("c.md", "Unrelated content");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-2", f2, { category: "document" });
      await service.publish("ao-3", f3, { category: "document" });

      const results = await service.grep("payment");
      expect(results.length).toBe(2);

      const allMatches = results.flatMap((r) => r.matches);
      expect(allMatches.length).toBe(2);
    });

    it("skips binary artifacts", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("doc.md", "payment info");
      const f2 = writeTestFile("img.png", "payment in binary");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-1", f2, { category: "screenshot" });

      const results = await service.grep("payment");
      expect(results.length).toBe(1);
      expect(results[0].artifact.filename).toBe("doc.md");
    });

    it("respects session filter", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "payment info");
      const f2 = writeTestFile("b.md", "payment info too");
      await service.publish("ao-1", f1, { category: "document" });
      await service.publish("ao-2", f2, { category: "document" });

      const results = await service.grep("payment", { sessionId: "ao-1" });
      expect(results.length).toBe(1);
    });

    it("returns empty for no matches", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "some content");
      await service.publish("ao-1", f, { category: "document" });

      const results = await service.grep("nonexistent");
      expect(results.length).toBe(0);
    });
  });

  describe("updateStatus", () => {
    it("changes artifact status", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });
      expect(entry.status).toBe("published");

      const updated = await service.updateStatus(entry.id, "verified");
      expect(updated.status).toBe("verified");
      expect(updated.updatedAt).not.toBe(entry.updatedAt);
    });
  });

  describe("update", () => {
    it("updates description and tags", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });

      const updated = await service.update(entry.id, {
        description: "Updated description",
        tags: ["new-tag"],
      });

      expect(updated.description).toBe("Updated description");
      expect(updated.tags).toEqual(["new-tag"]);
    });

    it("throws for non-existent artifact", async () => {
      const service = createService();
      await service.init();

      await expect(
        service.update("nonexistent", { description: "test" }),
      ).rejects.toThrow("Artifact not found");
    });
  });

  describe("delete", () => {
    it("tombstones artifact (file removed, entry remains)", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });
      const artifactPath = join(artifactsDir, entry.path);
      expect(existsSync(artifactPath)).toBe(true);

      await service.delete(entry.id, { deletedBy: "ao-2" });

      // File removed
      expect(existsSync(artifactPath)).toBe(false);

      // Entry still in manifest with deleted status
      const withDeleted = await service.list({ includeDeleted: true });
      expect(withDeleted.length).toBe(1);
      expect(withDeleted[0].status).toBe("deleted");
      expect(withDeleted[0].deletedBy).toBe("ao-2");
    });

    it("purges artifact completely", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });

      await service.delete(entry.id, { purge: true });

      const all = await service.list({ includeDeleted: true });
      expect(all.length).toBe(0);
    });
  });

  describe("rebuildManifest", () => {
    it("rebuilds from sidecar metadata", async () => {
      const service = createService();
      await service.init();

      const f1 = writeTestFile("a.md", "Content A");
      const f2 = writeTestFile("b.md", "Content B");
      await service.publish("ao-1", f1, {
        category: "document",
        description: "Doc A",
      });
      await service.publish("ao-2", f2, {
        category: "test-report",
        description: "Report B",
      });

      // Delete the manifest
      rmSync(join(artifactsDir, "manifest.json"));
      expect(existsSync(join(artifactsDir, "manifest.json"))).toBe(false);

      // Rebuild
      await service.rebuildManifest();

      // Verify rebuild
      const all = await service.list();
      expect(all.length).toBe(2);

      // Metadata should be preserved from sidecars
      const docA = all.find((e) => e.description === "Doc A");
      expect(docA).toBeTruthy();
      expect(docA!.category).toBe("document");

      const reportB = all.find((e) => e.description === "Report B");
      expect(reportB).toBeTruthy();
      expect(reportB!.category).toBe("test-report");
    });

    it("creates skeleton entries when no sidecar exists", async () => {
      const service = createService();
      await service.init();

      // Manually create a file without sidecar
      const sessionDir = join(artifactsDir, "ao-1");
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "orphan.md"), "Orphan content");

      await service.rebuildManifest();

      const all = await service.list();
      expect(all.length).toBe(1);
      expect(all[0].filename).toBe("orphan.md");
      expect(all[0].category).toBe("other"); // default when no sidecar
    });
  });

  describe("publish guards", () => {
    it("blocks .env files when worktreePath is set", async () => {
      const service = createArtifactService({
        artifactsDir,
        worktreePath: worktreeDir,
      });
      await service.init();

      const filePath = writeTestFile(".env", "SECRET=abc123");
      await expect(
        service.publish("ao-1", filePath, { category: "other" }),
      ).rejects.toThrow("security filter");
    });

    it("blocks credentials files when worktreePath is set", async () => {
      const service = createArtifactService({
        artifactsDir,
        worktreePath: worktreeDir,
      });
      await service.init();

      const filePath = writeTestFile("credentials.json", '{"key":"secret"}');
      await expect(
        service.publish("ao-1", filePath, { category: "other" }),
      ).rejects.toThrow("security filter");
    });

    it("blocks path traversal outside worktree", async () => {
      const service = createArtifactService({
        artifactsDir,
        worktreePath: worktreeDir,
      });
      await service.init();

      // Write file outside worktree
      const outsidePath = join(tmpDir, "outside.md");
      writeFileSync(outsidePath, "outside content");
      await expect(
        service.publish("ao-1", outsidePath, { category: "document" }),
      ).rejects.toThrow("outside worktree");
    });

    it("allows safe files when worktreePath is set", async () => {
      const service = createArtifactService({
        artifactsDir,
        worktreePath: worktreeDir,
      });
      await service.init();

      const filePath = writeTestFile("design.md", "Safe content");
      const entry = await service.publish("ao-1", filePath, { category: "document" });
      expect(entry.filename).toBe("design.md");
    });

    it("skips guards when worktreePath is not set", async () => {
      const service = createService();
      await service.init();

      // Without worktreePath, file outside artifacts dir is allowed
      const outsidePath = join(tmpDir, "outside.md");
      writeFileSync(outsidePath, "outside content");
      const entry = await service.publish("ao-1", outsidePath, { category: "document" });
      expect(entry.filename).toBe("outside.md");
    });
  });

  describe("prefix ID matching", () => {
    it("resolves artifact by ID prefix", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });
      const prefix = entry.id.slice(0, 8);

      const result = await service.get(prefix);
      expect(result).not.toBeNull();
      expect(result!.entry.id).toBe(entry.id);
    });

    it("resolves artifact by full ID", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });

      const result = await service.get(entry.id);
      expect(result).not.toBeNull();
      expect(result!.entry.id).toBe(entry.id);
    });

    it("returns null for non-matching prefix", async () => {
      const service = createService();
      await service.init();

      const result = await service.get("xxxxxxxx");
      expect(result).toBeNull();
    });

    it("update works with ID prefix", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });
      const prefix = entry.id.slice(0, 8);

      const updated = await service.update(prefix, { description: "new desc" });
      expect(updated.description).toBe("new desc");
      expect(updated.id).toBe(entry.id);
    });

    it("delete works with ID prefix", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      const entry = await service.publish("ao-1", f, { category: "document" });
      const prefix = entry.id.slice(0, 8);

      await service.delete(prefix);
      const all = await service.list();
      expect(all.length).toBe(0);
    });
  });

  describe("ensureManifest (auto-recovery)", () => {
    it("auto-rebuilds manifest when missing but directories exist", async () => {
      const service = createService();
      await service.init();

      const f = writeTestFile("doc.md", "content");
      await service.publish("ao-1", f, { category: "document" });

      // Delete manifest
      rmSync(join(artifactsDir, "manifest.json"));

      // list() should trigger auto-rebuild
      const all = await service.list();
      expect(all.length).toBe(1);
    });
  });
});

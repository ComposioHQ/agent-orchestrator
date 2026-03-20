import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SCM, PRInfo } from "../types.js";
import {
  generateEvidenceBundle,
  reviewEvidenceBundle,
  writeEvidenceBundle,
  type EvidenceBundle,
} from "../evidence-bundle.js";

vi.mock("node:child_process");

import { execFileSync } from "node:child_process";
const mockExecFileSync = vi.mocked(execFileSync);

const mockPr: PRInfo = {
  number: 42,
  url: "https://github.com/owner/repo/pull/42",
  title: "Test PR",
  owner: "owner",
  repo: "repo",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
};

const mockScm = {
  name: "test-scm",
  getCIChecks: vi.fn().mockResolvedValue([
    { name: "build", status: "passed", conclusion: "success", url: "https://ci.example.com/1" },
  ]),
  getCISummary: vi.fn().mockResolvedValue("passing"),
  detectPR: vi.fn(),
  getPRState: vi.fn(),
  mergePR: vi.fn(),
  closePR: vi.fn(),
  getReviews: vi.fn(),
  getReviewDecision: vi.fn(),
  getPendingComments: vi.fn(),
  getAutomatedComments: vi.fn(),
  getMergeability: vi.fn(),
} as unknown as SCM;

describe("evidence-bundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const argsStr = args ? args.join(" ") : "";
      if (argsStr.includes("--name-only")) {
        return "src/foo.ts\nsrc/bar.ts\n";
      }
      if (argsStr.includes("--stat")) {
        return "2 files changed, 10 insertions(+), 5 deletions(-)";
      }
      return "";
    });
  });

  describe("generateEvidenceBundle", () => {
    it("includes CI checks from SCM", async () => {
      const bundle = await generateEvidenceBundle(mockPr, mockScm, "/workspace");
      expect(bundle.ciChecks).toHaveLength(1);
      expect(bundle.ciChecks[0]!.name).toBe("build");
      expect(bundle.ciChecks[0]!.status).toBe("passed");
    });

    it("includes changed files", async () => {
      const bundle = await generateEvidenceBundle(mockPr, mockScm, "/workspace");
      expect(bundle.changedFiles).toContain("src/foo.ts");
      expect(bundle.changedFiles).toContain("src/bar.ts");
    });

    it("includes diff stats and correct timestamp", async () => {
      const bundle = await generateEvidenceBundle(mockPr, mockScm, "/workspace");
      expect(bundle.diffStats.filesChanged).toBe(2);
      expect(bundle.diffStats.additions).toBe(10);
      expect(bundle.diffStats.deletions).toBe(5);
      expect(bundle.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("calls execFileSync instead of execSync", async () => {
      await generateEvidenceBundle(mockPr, mockScm, "/workspace");
      expect(mockExecFileSync).toHaveBeenCalledTimes(2);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining(["diff"]),
        expect.objectContaining({ cwd: "/workspace", encoding: "utf8" }),
      );
    });

    it("uses baseBranch from PR for git diff ref", async () => {
      const customPr = { ...mockPr, baseBranch: "develop" };
      await generateEvidenceBundle(customPr, mockScm, "/workspace");
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["diff", "--name-only", "develop...HEAD"],
        expect.objectContaining({ cwd: "/workspace" }),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["diff", "--stat", "develop...HEAD"],
        expect.objectContaining({ cwd: "/workspace" }),
      );
    });
  });

  describe("reviewEvidenceBundle", () => {
    const baseBundle: EvidenceBundle = {
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      branch: "feat/test",
      generatedAt: new Date().toISOString(),
      ciChecks: [{ name: "build", status: "passed", conclusion: "success", url: null }],
      changedFiles: ["src/foo.ts"],
      diffStats: { additions: 5, deletions: 2, filesChanged: 1 },
      verdict: { passed: true, reasons: [], reviewedAt: new Date().toISOString() },
    };

    it("passes when all CI green and files changed", () => {
      const verdict = reviewEvidenceBundle(baseBundle);
      expect(verdict.passed).toBe(true);
      expect(verdict.reasons).toHaveLength(0);
    });

    it("fails when CI failing", () => {
      const failingBundle: EvidenceBundle = {
        ...baseBundle,
        ciChecks: [{ name: "build", status: "failed", conclusion: "failure", url: null }],
      };
      const verdict = reviewEvidenceBundle(failingBundle);
      expect(verdict.passed).toBe(false);
    });

    it("fails when no files changed", () => {
      const emptyBundle: EvidenceBundle = {
        ...baseBundle,
        changedFiles: [],
      };
      const verdict = reviewEvidenceBundle(emptyBundle);
      expect(verdict.passed).toBe(false);
    });

    it("includes failure reasons", () => {
      const failingBundle: EvidenceBundle = {
        ...baseBundle,
        ciChecks: [{ name: "build", status: "failed", conclusion: "failure", url: null }],
      };
      const verdict = reviewEvidenceBundle(failingBundle);
      expect(verdict.reasons.length).toBeGreaterThan(0);
      expect(verdict.reasons[0]).toContain("build");
    });

    it("treats skipped CI checks as non-failures", () => {
      const skippedBundle: EvidenceBundle = {
        ...baseBundle,
        ciChecks: [
          { name: "build", status: "passed", conclusion: "success", url: null },
          { name: "optional-lint", status: "skipped", conclusion: null, url: null },
        ],
      };
      const verdict = reviewEvidenceBundle(skippedBundle);
      expect(verdict.passed).toBe(true);
      expect(verdict.reasons).toHaveLength(0);
    });
  });

  describe("writeEvidenceBundle", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `evidence-bundle-test-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    const sampleBundle: EvidenceBundle = {
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
      branch: "feat/test",
      generatedAt: new Date().toISOString(),
      ciChecks: [{ name: "build", status: "passed", conclusion: "success", url: null }],
      changedFiles: ["src/foo.ts"],
      diffStats: { additions: 5, deletions: 2, filesChanged: 1 },
      verdict: { passed: true, reasons: [], reviewedAt: new Date().toISOString() },
    };

    it("writes bundle.json", () => {
      writeEvidenceBundle(sampleBundle, tmpDir);
      const content = readFileSync(join(tmpDir, "bundle.json"), "utf8");
      const parsed = JSON.parse(content) as EvidenceBundle;
      expect(parsed.prNumber).toBe(42);
      expect(parsed.ciChecks).toHaveLength(1);
      expect(parsed.changedFiles).toContain("src/foo.ts");
    });

    it("writes verdict.json", () => {
      writeEvidenceBundle(sampleBundle, tmpDir);
      const content = readFileSync(join(tmpDir, "verdict.json"), "utf8");
      const parsed = JSON.parse(content) as { passed: boolean; reasons: string[] };
      expect(parsed).toHaveProperty("passed");
      expect(parsed.passed).toBe(true);
    });
  });
});

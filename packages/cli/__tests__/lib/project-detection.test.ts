import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  detectProjectType,
  formatProjectTypeForDisplay,
} from "../../src/lib/project-detection.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ao-test-detect-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// detectProjectType
// =============================================================================

describe("detectProjectType", () => {
  it("returns empty project type for empty directory", () => {
    const result = detectProjectType(tmpDir);
    expect(result.languages).toEqual([]);
    expect(result.frameworks).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.testFramework).toBeUndefined();
    expect(result.packageManager).toBeUndefined();
  });

  describe("JavaScript/TypeScript detection", () => {
    it("detects JavaScript project with package.json", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("javascript");
    });

    it("detects TypeScript when tsconfig.json exists", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "tsconfig.json"), "{}");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("typescript");
      expect(result.languages).not.toContain("javascript");
    });

    it("detects TypeScript when tsconfig.base.json exists", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "tsconfig.base.json"), "{}");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("typescript");
    });

    it("detects TypeScript from devDependencies", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { typescript: "^5.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("typescript");
    });
  });

  describe("framework detection", () => {
    it("detects React", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: { react: "^18.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("react");
    });

    it("detects Next.js", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: { next: "^14.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("nextjs");
    });

    it("detects Vue", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: { vue: "^3.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("vue");
    });

    it("detects Express", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", dependencies: { express: "^4.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("express");
    });

    it("detects multiple frameworks", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test",
          dependencies: { react: "^18.0.0", next: "^14.0.0" },
        }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("react");
      expect(result.frameworks).toContain("nextjs");
    });

    it("detects frameworks from devDependencies", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { react: "^18.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("react");
    });
  });

  describe("test framework detection", () => {
    it("detects vitest", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { vitest: "^1.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.testFramework).toBe("vitest");
    });

    it("detects jest", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { jest: "^29.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.testFramework).toBe("jest");
    });

    it("detects mocha", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { mocha: "^10.0.0" } }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.testFramework).toBe("mocha");
    });

    it("prefers vitest over jest when both present", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "test",
          devDependencies: { vitest: "^1.0.0", jest: "^29.0.0" },
        }),
      );

      const result = detectProjectType(tmpDir);
      expect(result.testFramework).toBe("vitest");
    });
  });

  describe("package manager detection", () => {
    it("detects pnpm from lock file", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");

      const result = detectProjectType(tmpDir);
      expect(result.packageManager).toBe("pnpm");
    });

    it("detects pnpm workspaces", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");

      const result = detectProjectType(tmpDir);
      expect(result.packageManager).toBe("pnpm");
      expect(result.tools).toContain("pnpm-workspaces");
    });

    it("detects yarn from lock file", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "yarn.lock"), "");

      const result = detectProjectType(tmpDir);
      expect(result.packageManager).toBe("yarn");
    });

    it("detects npm from lock file", () => {
      writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
      writeFileSync(join(tmpDir, "package-lock.json"), "{}");

      const result = detectProjectType(tmpDir);
      expect(result.packageManager).toBe("npm");
    });
  });

  describe("Python detection", () => {
    it("detects Python from pyproject.toml", () => {
      writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\nname = 'test'\n");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("python");
      expect(result.tools).toContain("pyproject");
    });

    it("detects Python from requirements.txt", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0\n");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("python");
    });

    it("detects Python from setup.py", () => {
      writeFileSync(join(tmpDir, "setup.py"), "from setuptools import setup\n");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("python");
    });

    it("detects FastAPI framework", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "fastapi==0.100.0\nuvicorn\n");

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("fastapi");
    });

    it("detects Django framework", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "django==4.2\n");

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("django");
    });

    it("detects Flask framework", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0\n");

      const result = detectProjectType(tmpDir);
      expect(result.frameworks).toContain("flask");
    });

    it("detects pytest test framework", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "pytest==7.0.0\n");

      const result = detectProjectType(tmpDir);
      expect(result.testFramework).toBe("pytest");
    });

    it("avoids duplicate frameworks from multiple files", () => {
      writeFileSync(join(tmpDir, "requirements.txt"), "fastapi==0.100.0\n");
      writeFileSync(join(tmpDir, "pyproject.toml"), "[project]\ndependencies=['fastapi']\n");

      const result = detectProjectType(tmpDir);
      const fastApiCount = result.frameworks.filter((f) => f === "fastapi").length;
      expect(fastApiCount).toBe(1);
    });
  });

  describe("Go detection", () => {
    it("detects Go from go.mod", () => {
      writeFileSync(join(tmpDir, "go.mod"), "module example.com/test\n\ngo 1.21\n");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("go");
    });
  });

  describe("Rust detection", () => {
    it("detects Rust from Cargo.toml", () => {
      writeFileSync(join(tmpDir, "Cargo.toml"), '[package]\nname = "test"\n');

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("rust");
    });
  });

  describe("multi-language projects", () => {
    it("detects both TypeScript and Python", () => {
      writeFileSync(
        join(tmpDir, "package.json"),
        JSON.stringify({ name: "test", devDependencies: { typescript: "^5.0.0" } }),
      );
      writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
      writeFileSync(join(tmpDir, "requirements.txt"), "flask==2.0.0\n");

      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("typescript");
      expect(result.languages).toContain("python");
    });
  });

  describe("corrupted files", () => {
    it("handles corrupted package.json gracefully", () => {
      writeFileSync(join(tmpDir, "package.json"), "not valid json{{{");

      // Should not throw — readJson returns null on parse error
      const result = detectProjectType(tmpDir);
      expect(result.languages).toContain("javascript"); // Still detected by file presence
    });
  });
});

// =============================================================================
// formatProjectTypeForDisplay
// =============================================================================

describe("formatProjectTypeForDisplay", () => {
  it("formats a full project type", () => {
    const result = formatProjectTypeForDisplay({
      languages: ["typescript"],
      frameworks: ["react", "nextjs"],
      tools: ["pnpm-workspaces"],
      testFramework: "vitest",
      packageManager: "pnpm",
    });

    expect(result).toContain("Languages: typescript");
    expect(result).toContain("Frameworks: react, nextjs");
    expect(result).toContain("Package Manager: pnpm");
    expect(result).toContain("Test Framework: vitest");
    expect(result).toContain("Tools: pnpm-workspaces");
  });

  it("omits empty sections", () => {
    const result = formatProjectTypeForDisplay({
      languages: ["go"],
      frameworks: [],
      tools: [],
    });

    expect(result).toContain("Languages: go");
    expect(result).not.toContain("Frameworks:");
    expect(result).not.toContain("Package Manager:");
    expect(result).not.toContain("Test Framework:");
    expect(result).not.toContain("Tools:");
  });

  it("returns empty string for empty project type", () => {
    const result = formatProjectTypeForDisplay({
      languages: [],
      frameworks: [],
      tools: [],
    });

    expect(result).toBe("");
  });
});

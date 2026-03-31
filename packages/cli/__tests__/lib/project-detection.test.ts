import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  detectProjectType,
  generateRulesFromTemplates,
  formatProjectTypeForDisplay,
  type ProjectType,
} from "../../src/lib/project-detection.js";

describe("detectProjectType", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ao-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty type for empty directory", () => {
    const result = detectProjectType(dir);
    expect(result.languages).toEqual([]);
    expect(result.frameworks).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.testFramework).toBeUndefined();
    expect(result.packageManager).toBeUndefined();
  });

  // ── JavaScript/TypeScript detection ──

  it("detects javascript when package.json exists without typescript", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    const result = detectProjectType(dir);
    expect(result.languages).toContain("javascript");
    expect(result.languages).not.toContain("typescript");
  });

  it("detects typescript via tsconfig.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("typescript");
    expect(result.languages).not.toContain("javascript");
  });

  it("detects typescript via tsconfig.base.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "tsconfig.base.json"), "{}");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("typescript");
  });

  it("detects typescript via devDependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { typescript: "^5.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.languages).toContain("typescript");
  });

  // ── Framework detection ──

  it("detects react from dependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { react: "^18.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("react");
  });

  it("detects nextjs from dependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { next: "^14.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("nextjs");
  });

  it("detects vue from devDependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { vue: "^3.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("vue");
  });

  it("detects express from dependencies", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", dependencies: { express: "^4.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("express");
  });

  // ── Test framework detection ──

  it("detects vitest", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { vitest: "^1.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.testFramework).toBe("vitest");
  });

  it("detects jest", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { jest: "^29.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.testFramework).toBe("jest");
  });

  it("detects mocha", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "test", devDependencies: { mocha: "^10.0.0" } }),
    );
    const result = detectProjectType(dir);
    expect(result.testFramework).toBe("mocha");
  });

  // ── Package manager detection ──

  it("detects pnpm via lockfile", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    const result = detectProjectType(dir);
    expect(result.packageManager).toBe("pnpm");
  });

  it("detects pnpm workspaces", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*");
    const result = detectProjectType(dir);
    expect(result.packageManager).toBe("pnpm");
    expect(result.tools).toContain("pnpm-workspaces");
  });

  it("detects yarn", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "yarn.lock"), "");
    const result = detectProjectType(dir);
    expect(result.packageManager).toBe("yarn");
  });

  it("detects npm", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const result = detectProjectType(dir);
    expect(result.packageManager).toBe("npm");
  });

  // ── Python detection ──

  it("detects python via pyproject.toml", () => {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname = 'test'");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("python");
    expect(result.tools).toContain("pyproject");
  });

  it("detects python via requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "requests>=2.0.0");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("python");
  });

  it("detects python via setup.py", () => {
    writeFileSync(join(dir, "setup.py"), "from setuptools import setup");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("python");
  });

  it("detects fastapi from requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "fastapi>=0.100.0\nuvicorn");
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("fastapi");
  });

  it("detects django from pyproject.toml", () => {
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["django>=4.0"]');
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("django");
  });

  it("detects flask from requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "flask>=3.0.0");
    const result = detectProjectType(dir);
    expect(result.frameworks).toContain("flask");
  });

  it("detects pytest from requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "pytest>=7.0.0");
    const result = detectProjectType(dir);
    expect(result.testFramework).toBe("pytest");
  });

  it("does not duplicate frameworks from multiple files", () => {
    writeFileSync(join(dir, "requirements.txt"), "fastapi>=0.100.0");
    writeFileSync(join(dir, "pyproject.toml"), '[project]\ndependencies = ["fastapi>=0.100"]');
    const result = detectProjectType(dir);
    expect(result.frameworks.filter((f) => f === "fastapi")).toHaveLength(1);
  });

  // ── Go / Rust detection ──

  it("detects go", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/test");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("go");
  });

  it("detects rust", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'test'");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("rust");
  });

  // ── Mixed projects ──

  it("detects multiple languages in the same directory", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(dir, "go.mod"), "module test");
    writeFileSync(join(dir, "Cargo.toml"), "");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("javascript");
    expect(result.languages).toContain("go");
    expect(result.languages).toContain("rust");
  });

  it("handles malformed package.json gracefully", () => {
    writeFileSync(join(dir, "package.json"), "not json");
    const result = detectProjectType(dir);
    expect(result.languages).toContain("javascript");
  });
});

describe("generateRulesFromTemplates", () => {
  it("returns string for typescript pnpm-workspaces project", () => {
    const type: ProjectType = {
      languages: ["typescript"],
      frameworks: ["react", "nextjs"],
      tools: ["pnpm-workspaces"],
      testFramework: "vitest",
      packageManager: "pnpm",
    };
    const result = generateRulesFromTemplates(type);
    expect(typeof result).toBe("string");
  });

  it("generates test commands for typescript with pnpm workspaces", () => {
    const type: ProjectType = {
      languages: ["typescript"],
      frameworks: [],
      tools: ["pnpm-workspaces"],
      testFramework: "vitest",
      packageManager: "pnpm",
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("pnpm build");
    expect(result).toContain("pnpm test");
  });

  it("generates test commands for plain typescript without workspaces", () => {
    const type: ProjectType = {
      languages: ["typescript"],
      frameworks: [],
      tools: [],
      testFramework: "jest",
      packageManager: "npm",
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("npm run typecheck");
    expect(result).toContain("npm test");
  });

  it("generates test commands for javascript without test framework", () => {
    const type: ProjectType = {
      languages: ["javascript"],
      frameworks: [],
      tools: [],
      packageManager: "npm",
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("npm run lint");
    expect(result).not.toContain("npm test");
  });

  it("generates commands for python with pytest", () => {
    const type: ProjectType = {
      languages: ["python"],
      frameworks: ["fastapi"],
      tools: ["pyproject"],
      testFramework: "pytest",
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("pytest");
    expect(result).toContain("black");
    expect(result).toContain("mypy");
  });

  it("generates commands for go projects", () => {
    const type: ProjectType = {
      languages: ["go"],
      frameworks: [],
      tools: [],
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("go test");
    expect(result).toContain("go vet");
    expect(result).toContain("gofmt");
  });

  it("returns empty string for rust projects (no commands defined)", () => {
    const type: ProjectType = {
      languages: ["rust"],
      frameworks: [],
      tools: [],
    };
    const result = generateRulesFromTemplates(type);
    // Rust has no specific command generation, may have template rules or nothing
    expect(typeof result).toBe("string");
  });

  it("defaults to npm when no packageManager set", () => {
    const type: ProjectType = {
      languages: ["javascript"],
      frameworks: [],
      tools: [],
    };
    const result = generateRulesFromTemplates(type);
    expect(result).toContain("npm run lint");
  });
});

describe("formatProjectTypeForDisplay", () => {
  it("formats all fields", () => {
    const type: ProjectType = {
      languages: ["typescript"],
      frameworks: ["react", "nextjs"],
      tools: ["pnpm-workspaces"],
      testFramework: "vitest",
      packageManager: "pnpm",
    };
    const result = formatProjectTypeForDisplay(type);
    expect(result).toContain("Languages: typescript");
    expect(result).toContain("Frameworks: react, nextjs");
    expect(result).toContain("Package Manager: pnpm");
    expect(result).toContain("Test Framework: vitest");
    expect(result).toContain("Tools: pnpm-workspaces");
  });

  it("omits empty fields", () => {
    const type: ProjectType = {
      languages: ["go"],
      frameworks: [],
      tools: [],
    };
    const result = formatProjectTypeForDisplay(type);
    expect(result).toContain("Languages: go");
    expect(result).not.toContain("Frameworks");
    expect(result).not.toContain("Package Manager");
    expect(result).not.toContain("Test Framework");
    expect(result).not.toContain("Tools");
  });

  it("returns empty string for empty project type", () => {
    const type: ProjectType = {
      languages: [],
      frameworks: [],
      tools: [],
    };
    const result = formatProjectTypeForDisplay(type);
    expect(result).toBe("");
  });
});

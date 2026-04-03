import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  gatherContext,
  generateDirectoryTree,
  gatherConfigFiles,
  readFileIfExists,
  gatherGitLog,
} from "../context.js";

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `ao-context-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("generateDirectoryTree", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces correct indented output", () => {
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
    writeFileSync(join(tmpDir, "package.json"), "{}");

    return generateDirectoryTree(tmpDir, 3, []).then((tree) => {
      expect(tree).toContain("src/");
      expect(tree).toContain("  index.ts");
      expect(tree).toContain("package.json");
    });
  });

  it("lists directories before files", () => {
    mkdirSync(join(tmpDir, "alpha"));
    writeFileSync(join(tmpDir, "aaa.txt"), "");

    return generateDirectoryTree(tmpDir, 3, []).then((tree) => {
      const lines = tree.split("\n");
      const dirIndex = lines.findIndex((l) => l.includes("alpha/"));
      const fileIndex = lines.findIndex((l) => l.includes("aaa.txt"));
      expect(dirIndex).toBeLessThan(fileIndex);
    });
  });

  it("respects maxDepth limit", () => {
    mkdirSync(join(tmpDir, "a", "b", "c"), { recursive: true });
    writeFileSync(join(tmpDir, "a", "b", "c", "deep.txt"), "");

    return generateDirectoryTree(tmpDir, 2, []).then((tree) => {
      expect(tree).toContain("a/");
      expect(tree).toContain("b/");
      expect(tree).not.toContain("c/");
      expect(tree).not.toContain("deep.txt");
    });
  });

  it("excludes matching patterns", () => {
    mkdirSync(join(tmpDir, "node_modules"));
    writeFileSync(join(tmpDir, "node_modules", "pkg.js"), "");
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "app.ts"), "");

    return generateDirectoryTree(tmpDir, 3, ["node_modules"]).then((tree) => {
      expect(tree).not.toContain("node_modules");
      expect(tree).toContain("src/");
      expect(tree).toContain("app.ts");
    });
  });

  it("excludes hidden directories (dotfiles)", () => {
    mkdirSync(join(tmpDir, ".git"));
    writeFileSync(join(tmpDir, ".git", "config"), "");
    writeFileSync(join(tmpDir, "visible.txt"), "");

    return generateDirectoryTree(tmpDir, 3, []).then((tree) => {
      expect(tree).not.toContain(".git");
      expect(tree).toContain("visible.txt");
    });
  });

  it("returns empty string for empty directory", () => {
    return generateDirectoryTree(tmpDir, 3, []).then((tree) => {
      expect(tree).toBe("");
    });
  });
});

describe("gatherConfigFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads package.json when present", async () => {
    writeFileSync(join(tmpDir, "package.json"), '{"name":"test"}');
    const configs = await gatherConfigFiles(tmpDir);
    expect(configs["package.json"]).toBe('{"name":"test"}');
  });

  it("skips missing files without error", async () => {
    const configs = await gatherConfigFiles(tmpDir);
    expect(Object.keys(configs)).toHaveLength(0);
  });

  it("reads multiple config files", async () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    const configs = await gatherConfigFiles(tmpDir);
    expect(Object.keys(configs)).toHaveLength(2);
    expect(configs["package.json"]).toBeDefined();
    expect(configs["tsconfig.json"]).toBeDefined();
  });
});

describe("readFileIfExists", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns content for existing file", async () => {
    const filePath = join(tmpDir, "test.txt");
    writeFileSync(filePath, "hello world");
    const content = await readFileIfExists(filePath);
    expect(content).toBe("hello world");
  });

  it("returns null for non-existent file", async () => {
    const content = await readFileIfExists(join(tmpDir, "nope.txt"));
    expect(content).toBeNull();
  });
});

describe("gatherGitLog", () => {
  it("returns git log for a real git repo", async () => {
    // Use the actual repo we're in
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const log = await gatherGitLog(repoRoot, 5);
    expect(log).not.toBeNull();
    expect(log!.split("\n").length).toBeLessThanOrEqual(5);
  });

  it("returns null for non-git directory", async () => {
    const tmpDir = createTempDir();
    try {
      const log = await gatherGitLog(tmpDir, 5);
      expect(log).toBeNull();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("gatherContext", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    writeFileSync(join(tmpDir, "README.md"), "# Test");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "index.ts"), "");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("gathers all parts when all flags enabled", async () => {
    const ctx = await gatherContext(tmpDir, {
      gather_tree: true,
      gather_configs: true,
      gather_readme: true,
      gather_claude_md: true,
      gather_git_log: true,
      git_log_count: 10,
      max_tree_depth: 3,
      exclude_patterns: ["node_modules", ".git"],
    });
    expect(ctx.directoryTree).toContain("src/");
    expect(ctx.configFiles["package.json"]).toBe("{}");
    expect(ctx.readme).toBe("# Test");
    expect(ctx.claudeMd).toBeNull(); // no CLAUDE.md in tmpDir
    // gitLog may be null since tmpDir is not a git repo
  });

  it("respects disabled flags", async () => {
    const ctx = await gatherContext(tmpDir, {
      gather_tree: false,
      gather_configs: false,
      gather_readme: false,
      gather_claude_md: false,
      gather_git_log: false,
      git_log_count: 10,
      max_tree_depth: 3,
      exclude_patterns: [],
    });
    expect(ctx.directoryTree).toBe("");
    expect(ctx.configFiles).toEqual({});
    expect(ctx.readme).toBeNull();
    expect(ctx.claudeMd).toBeNull();
    expect(ctx.gitLog).toBeNull();
  });
});

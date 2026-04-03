import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { z } from "zod";
import type { ContextConfigSchema } from "./config.js";
import type { RepoContext } from "./types.js";

const execFileAsync = promisify(execFile);

type ContextConfig = z.infer<typeof ContextConfigSchema>;

// Known config files to look for at repo root
const CONFIG_FILE_NAMES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "tsconfig.base.json",
];

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Gather repository context based on config flags.
 * All operations are deterministic (no LLM calls).
 */
export async function gatherContext(
  repoPath: string,
  config: ContextConfig,
): Promise<RepoContext> {
  const [directoryTree, configFiles, readme, claudeMd, gitLog] =
    await Promise.all([
      config.gather_tree
        ? generateDirectoryTree(
            repoPath,
            config.max_tree_depth,
            config.exclude_patterns,
          )
        : Promise.resolve(""),
      config.gather_configs
        ? gatherConfigFiles(repoPath)
        : Promise.resolve({}),
      config.gather_readme
        ? readFileIfExists(join(repoPath, "README.md"))
        : Promise.resolve(null),
      config.gather_claude_md
        ? readFileIfExists(join(repoPath, "CLAUDE.md"))
        : Promise.resolve(null),
      config.gather_git_log
        ? gatherGitLog(repoPath, config.git_log_count)
        : Promise.resolve(null),
    ]);

  return { directoryTree, configFiles, readme, claudeMd, gitLog };
}

/**
 * Generate an indented directory tree string.
 * Directories listed first, then files, alphabetically within each group.
 */
export async function generateDirectoryTree(
  rootPath: string,
  maxDepth: number,
  excludePatterns: string[],
): Promise<string> {
  const lines: string[] = [];
  await walkDir(rootPath, 0, maxDepth, excludePatterns, lines, "");
  return lines.join("\n");
}

async function walkDir(
  dirPath: string,
  depth: number,
  maxDepth: number,
  excludePatterns: string[],
  lines: string[],
  indent: string,
): Promise<void> {
  if (depth >= maxDepth) return;

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return; // Permission denied or other read errors
  }

  // Filter excluded and hidden entries
  const filtered = entries.filter(
    (e) => !excludePatterns.includes(e.name) && !e.name.startsWith("."),
  );

  // Sort: directories first, then files, alphabetical within each
  const dirs = filtered.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered.filter((e) => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    lines.push(`${indent}${dir.name}/`);
    await walkDir(
      join(dirPath, dir.name),
      depth + 1,
      maxDepth,
      excludePatterns,
      lines,
      indent + "  ",
    );
  }

  for (const file of files) {
    lines.push(`${indent}${file.name}`);
  }
}

/**
 * Read known config files from repo root.
 * Returns a map of filename -> content for files that exist.
 */
export async function gatherConfigFiles(
  repoPath: string,
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const reads = CONFIG_FILE_NAMES.map(async (name) => {
    const content = await readFileIfExists(join(repoPath, name));
    if (content !== null) {
      results[name] = content;
    }
  });
  await Promise.all(reads);
  return results;
}

/**
 * Read a file, returning null if it doesn't exist.
 */
export async function readFileIfExists(
  filePath: string,
): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Get recent git log as a string. Returns null if not a git repo or git fails.
 */
export async function gatherGitLog(
  repoPath: string,
  count: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--oneline", `-${count}`],
      { cwd: repoPath },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

import { type NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const dynamic = "force-dynamic";

/** Maximum number of entries returned per request. */
const MAX_ENTRIES = 200;

/** Directories to hide from the browser (dot-prefixed are already excluded). */
const HIDDEN_NAMES = new Set(["node_modules", "__pycache__", ".git"]);

export async function GET(request: NextRequest) {
  try {
    const rawPath = request.nextUrl.searchParams.get("path");
    const dirPath = resolve(rawPath || homedir());

    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat?.isDirectory()) {
      return NextResponse.json(
        { error: `Not a directory: ${dirPath}` },
        { status: 400 },
      );
    }

    const entries = await readdir(dirPath, { withFileTypes: true });

    const directories: { name: string; path: string; hasChildren: boolean }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || HIDDEN_NAMES.has(entry.name)) continue;
      if (directories.length >= MAX_ENTRIES) break;

      const fullPath = join(dirPath, entry.name);

      // Peek one level to see if this directory has sub-directories
      let hasChildren = false;
      try {
        const children = await readdir(fullPath, { withFileTypes: true });
        hasChildren = children.some(
          (c) => c.isDirectory() && !c.name.startsWith(".") && !HIDDEN_NAMES.has(c.name),
        );
      } catch {
        // Permission denied or similar — treat as leaf
      }

      directories.push({ name: entry.name, path: fullPath, hasChildren });
    }

    directories.sort((a, b) => a.name.localeCompare(b.name));

    // Check if this directory itself contains a config marker (git repo, config file, etc.)
    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
    const hasConfig = entries.some((e) => e.name === "agent-orchestrator.yaml" || e.name === "agent-orchestrator.yml");

    return NextResponse.json({
      path: dirPath,
      parent: dirPath === "/" ? null : resolve(dirPath, ".."),
      directories,
      isGitRepo: hasGit,
      hasConfig,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to browse directory" },
      { status: 500 },
    );
  }
}

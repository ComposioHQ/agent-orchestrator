import { type NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPortfolioEnabled } from "@aoagents/ao-core";
import { resolveWorkspaceBrowsePath } from "@/lib/filesystem-access";

export const dynamic = "force-dynamic";

/** Maximum number of entries returned per request. */
const MAX_ENTRIES = 200;

/** Directories to hide from the browser (dot-prefixed are already excluded). */
const HIDDEN_NAMES = new Set(["node_modules", "__pycache__", ".git"]);

export async function GET(request: NextRequest) {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json({ error: "Portfolio mode is disabled" }, { status: 404 });
    }

    const rawPath = request.nextUrl.searchParams.get("path");
    const { resolvedPath: dirPath, rootPath } = resolveWorkspaceBrowsePath(rawPath);

    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) {
      return NextResponse.json(
        { error: `Not a directory: ${dirPath}` },
        { status: 400 },
      );
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const visibleDirectories = entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith(".") && !HIDDEN_NAMES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES);

    const directories: { name: string; path: string; hasChildren: boolean }[] = [];
    for (const entry of visibleDirectories) {
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

    // Check if this directory itself contains a config marker (git repo, config file, etc.)
    const hasGit = entries.some((e) => e.name === ".git" && e.isDirectory());
    const hasConfig = entries.some((e) => e.name === "agent-orchestrator.yaml" || e.name === "agent-orchestrator.yml");
    const parentCandidate = dirPath === rootPath ? null : resolve(dirPath, "..");
    const parent =
      parentCandidate && (parentCandidate === rootPath || parentCandidate.startsWith(`${rootPath}/`))
        ? parentCandidate
        : null;

    return NextResponse.json({
      path: dirPath,
      rootPath,
      parent,
      directories,
      isGitRepo: hasGit,
      hasConfig,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Access denied:")) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to browse directory" },
      { status: 500 },
    );
  }
}

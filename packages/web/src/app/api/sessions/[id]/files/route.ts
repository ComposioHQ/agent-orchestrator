import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

type GitStatus = "M" | "A" | "D" | "?" | "R";

function getGitStatus(worktreePath: string): Record<string, GitStatus> {
  const result: Record<string, GitStatus> = {};
  try {
    // -uall: list every untracked file path (default mode collapses dirs to one line, e.g. ?? .foo/
    // which would not match tree paths like .foo/bar.md — breaking badges and changed-files filter).
    const output = execSync("git status --porcelain=v1 -uall", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const line of output.split("\n")) {
      if (!line || line.length < 4) continue;
      const status = line[0] === "?" ? "?" : line[0] !== " " ? line[0] : line[1];
      const filePath = line.slice(3);
      result[filePath] = status as GitStatus;
    }
  } catch {
    // git not available or not a repo — return empty
  }
  return result;
}

function buildTree(dirPath: string, rootPath: string): FileNode[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    // Skip common ignored directories
    if ([".git", "node_modules", ".next", "dist", "build"].includes(entry.name)) {
      continue;
    }

    const fullPath = join(dirPath, entry.name);
    const relPath = relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: buildTree(fullPath, rootPath),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }
  return nodes;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return jsonWithCorrelation(
        { error: "Session not found" },
        { status: 404 },
        correlationId
      );
    }

    const worktreePath = session.workspacePath;
    if (!worktreePath) {
      return jsonWithCorrelation(
        { error: "Session has no workspace" },
        { status: 404 },
        correlationId
      );
    }

    const tree = buildTree(worktreePath, worktreePath);
    const gitStatus = getGitStatus(worktreePath);

    return jsonWithCorrelation(
      { tree, gitStatus },
      { status: 200 },
      correlationId
    );
  } catch (error) {
    console.error("Error fetching file tree:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch file tree" },
      { status: 500 },
      correlationId
    );
  }
}

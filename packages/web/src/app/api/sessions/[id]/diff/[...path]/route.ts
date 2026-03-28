import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const MAX_DIFF_BYTES = 512 * 1024; // 500KB cap (binary KB)
const MAX_UNTRACKED_READ = 1_048_576; // 1MB — align with file content route

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
]);

type GitStatus = "M" | "A" | "D" | "?" | "R";

function parsePorcelainStatus(line: string): GitStatus {
  if (line.startsWith("??")) return "?";
  const status = line[0] === "?" ? "?" : line[0] !== " " ? line[0] : line[1];
  return status as GitStatus;
}

function getPathGitStatus(worktreePath: string, filePath: string): GitStatus | undefined {
  const result = spawnSync("git", ["status", "--porcelain", "--", filePath], {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error || result.status === 128) return undefined;
  const out = (result.stdout ?? "").trim();
  if (!out) return undefined;
  const firstLine = out.split("\n")[0] ?? "";
  return parsePorcelainStatus(firstLine);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id, path: pathSegments } = await params;
    const filePath = pathSegments.join("/");

    if (!filePath) {
      return jsonWithCorrelation({ error: "Invalid path" }, { status: 400 }, correlationId);
    }

    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const worktreePath = session.workspacePath;
    if (!worktreePath) {
      return jsonWithCorrelation(
        { error: "Session has no workspace" },
        { status: 404 },
        correlationId
      );
    }

    const fullPath = join(worktreePath, filePath);

    if (!fullPath.startsWith(worktreePath)) {
      return jsonWithCorrelation({ error: "Invalid path" }, { status: 400 }, correlationId);
    }

    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";

    if (BINARY_EXTENSIONS.has(ext)) {
      return jsonWithCorrelation(
        {
          error: "binary",
          message: "Binary file diff is not supported",
          path: filePath,
        },
        { status: 422 },
        correlationId
      );
    }

    const statusFromGit = getPathGitStatus(worktreePath, filePath);
    const isUntracked = statusFromGit === "?";

    if (isUntracked) {
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        return jsonWithCorrelation(
          { error: "not_found", message: "File not found", path: filePath },
          { status: 404 },
          correlationId
        );
      }
      if (!stat.isFile()) {
        return jsonWithCorrelation({ error: "Invalid path" }, { status: 400 }, correlationId);
      }
      if (stat.size > MAX_UNTRACKED_READ) {
        return jsonWithCorrelation(
          {
            error: "too_large",
            message: `File is too large to diff (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
            path: filePath,
          },
          { status: 422 },
          correlationId
        );
      }
      const content = readFileSync(fullPath, "utf-8");
      const etag = `"u-${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }
      return jsonWithCorrelation(
        {
          path: filePath,
          status: "?" as const,
          diff: null,
          content,
        },
        { status: 200, headers: { ETag: etag } },
        correlationId
      );
    }

    const diffResult = spawnSync("git", ["diff", "HEAD", "--", filePath], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 600 * 1024,
    });

    if (diffResult.error) {
      const errMsg = diffResult.error.message ?? "";
      if (errMsg.includes("maxBuffer") || errMsg.includes("ENOBUFS")) {
        return jsonWithCorrelation(
          {
            error: "diff_too_large",
            message: "Diff too large to display",
            path: filePath,
          },
          { status: 422 },
          correlationId
        );
      }
      return jsonWithCorrelation(
        { error: "git_failed", message: diffResult.error.message, path: filePath },
        { status: 500 },
        correlationId
      );
    }

    if (diffResult.status !== 0 && diffResult.status !== 1) {
      return jsonWithCorrelation(
        { error: "git_error", message: (diffResult.stderr || "").trim() || "git diff failed", path: filePath },
        { status: 500 },
        correlationId
      );
    }

    const diffText = diffResult.stdout ?? "";
    if (diffText.includes("Binary files ") && diffText.includes(" differ")) {
      return jsonWithCorrelation(
        {
          error: "binary",
          message: "Binary file diff is not supported",
          path: filePath,
        },
        { status: 422 },
        correlationId
      );
    }
    if (diffText.length > MAX_DIFF_BYTES) {
      return jsonWithCorrelation(
        {
          error: "diff_too_large",
          message: "Diff too large to display",
          path: filePath,
        },
        { status: 422 },
        correlationId
      );
    }

    const effectiveStatus: GitStatus = statusFromGit ?? "M";
    const diffPayload = diffText.length > 0 ? diffText : null;
    const etag = `"d-${createHash("sha256").update(diffText).digest("hex").slice(0, 16)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    return jsonWithCorrelation(
      {
        path: filePath,
        status: effectiveStatus,
        diff: diffPayload,
        content: null,
      },
      { status: 200, headers: { ETag: etag } },
      correlationId
    );
  } catch (error) {
    console.error("Error fetching diff:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch diff" },
      { status: 500 },
      correlationId
    );
  }
}

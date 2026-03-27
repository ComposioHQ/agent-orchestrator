import { type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE_SIZE = 1_048_576; // 1MB

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id, path: pathSegments } = await params;
    const filePath = pathSegments.join("/");

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

    const fullPath = join(worktreePath, filePath);

    // Security: ensure path doesn't escape worktree
    if (!fullPath.startsWith(worktreePath)) {
      return jsonWithCorrelation(
        { error: "Invalid path" },
        { status: 400 },
        correlationId
      );
    }

    const stat = statSync(fullPath);
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

    // ETag for efficient polling
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }

    // Binary check
    if (BINARY_EXTENSIONS.has(ext)) {
      return jsonWithCorrelation(
        {
          error: "binary",
          message: "Binary file preview is not supported",
          path: filePath,
          size: stat.size,
        },
        { status: 422, headers: { ETag: etag } },
        correlationId
      );
    }

    // Size check
    if (stat.size > MAX_FILE_SIZE) {
      return jsonWithCorrelation(
        {
          error: "too_large",
          message: `File is too large to preview (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
          path: filePath,
          size: stat.size,
        },
        { status: 422, headers: { ETag: etag } },
        correlationId
      );
    }

    const content = readFileSync(fullPath, "utf-8");
    const response = jsonWithCorrelation(
      { content, path: filePath, size: stat.size, mtime: stat.mtime.toISOString() },
      { status: 200, headers: { ETag: etag } },
      correlationId
    );

    return response;
  } catch (error) {
    console.error("Error fetching file content:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch file content" },
      { status: 500 },
      correlationId
    );
  }
}

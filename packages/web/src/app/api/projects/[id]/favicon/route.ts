import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { assertPathWithinHome, isWithinDirectory } from "@/lib/path-security";
import { getPortfolioServices } from "@/lib/portfolio-services";

const CANDIDATES = [
  ["public", "favicon.ico"],
  ["public", "favicon.png"],
  ["public", "icon.png"],
  ["app", "favicon.ico"],
  ["app", "favicon.png"],
  ["src", "app", "favicon.ico"],
  ["src", "app", "favicon.png"],
] as const;

function contentType(path: readonly string[]) {
  const filename = path[path.length - 1];
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".svg")) return "image/svg+xml";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  return "image/x-icon";
}

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const project = getPortfolioServices().portfolio.find((entry) => entry.id === id);

  if (!project) {
    return new NextResponse(null, { status: 404 });
  }

  let repoPath: string;
  try {
    repoPath = await assertPathWithinHome(project.repoPath);
  } catch {
    return new NextResponse(null, { status: 404 });
  }

  for (const candidate of CANDIDATES) {
    try {
      const absolutePath = join(repoPath, ...candidate);
      const resolvedPath = await realpath(absolutePath);
      if (!isWithinDirectory(repoPath, resolvedPath)) {
        continue;
      }
      const file = await readFile(resolvedPath);
      return new NextResponse(file, {
        status: 200,
        headers: {
          "Content-Type": contentType(candidate),
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch {
      // Try the next candidate.
    }
  }

  return new NextResponse(null, { status: 404 });
}

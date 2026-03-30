import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
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

  for (const candidate of CANDIDATES) {
    try {
      const absolutePath = join(project.repoPath, ...candidate);
      const file = await readFile(absolutePath);
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

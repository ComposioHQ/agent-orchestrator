import { NextResponse } from "next/server";
import { getAllProjects } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const projects = getAllProjects();
    return NextResponse.json({ projects });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load projects" },
      { status: 500 },
    );
  }
}

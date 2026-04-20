import { NextResponse } from "next/server";
import { getGlobalConfigPath, loadConfig } from "@aoagents/ao-core";
import { invalidatePortfolioServicesCache } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    invalidatePortfolioServicesCache();
    const config = loadConfig(getGlobalConfigPath());

    return NextResponse.json({
      reloaded: true,
      projectCount: Object.keys(config.projects).length,
      degradedCount: Object.keys(config.degradedProjects).length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to reload projects" },
      { status: 500 },
    );
  }
}

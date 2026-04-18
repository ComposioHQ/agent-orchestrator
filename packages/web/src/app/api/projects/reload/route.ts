import { NextResponse } from "next/server";
import { isPortfolioEnabled } from "@aoagents/ao-core";
import { getPortfolioServices } from "@/lib/portfolio-services";
import { reloadServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json(
        { error: "Portfolio mode is disabled" },
        { status: 404 },
      );
    }

    const services = await reloadServices();
    const { portfolio } = getPortfolioServices();

    return NextResponse.json({
      ok: true,
      configPath: services.config.configPath,
      projectCount: Object.keys(services.config.projects).length,
      portfolioProjectCount: portfolio.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to reload projects" },
      { status: 500 },
    );
  }
}

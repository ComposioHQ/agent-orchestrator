import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { getDashboardUsage } from "@/lib/usage";

export async function GET() {
  try {
    const { config, registry, sessionManager } = await getServices();
    const sessions = await sessionManager.list();
    const usage = await getDashboardUsage(sessions, config, registry);
    return NextResponse.json(usage);
  } catch (error) {
    console.error("Failed to fetch usage:", error);
    return NextResponse.json({ error: "Failed to fetch usage" }, { status: 500 });
  }
}

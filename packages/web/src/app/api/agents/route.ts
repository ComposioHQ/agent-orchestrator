import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { registry } = await getServices();
    const agents = registry.list("agent").map((manifest) => ({
      id: manifest.name,
      name: manifest.displayName ?? manifest.name,
    }));

    return NextResponse.json({ agents });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load agents" },
      { status: 500 },
    );
  }
}

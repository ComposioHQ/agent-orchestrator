import { type NextRequest, NextResponse } from "next/server";
import { findConfigFile, writeRoutingConfig, type RoutingConfig, type RoutingMode } from "@composio/ao-core";
import { getServices } from "@/lib/services";

const VALID_MODES = new Set<RoutingMode>(["always-claude", "smart", "always-local"]);

export async function GET() {
  try {
    const { config } = await getServices();
    const routing: RoutingConfig = config.routing ?? {
      mode: "always-claude",
      localLlm: { baseUrl: "http://localhost:11434/v1", model: "" },
    };
    return NextResponse.json({ routing });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read routing config" },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { routing } = body as { routing?: unknown };
    if (!routing || typeof routing !== "object") {
      return NextResponse.json({ error: "Missing routing field" }, { status: 400 });
    }

    const r = routing as Record<string, unknown>;
    const rawMode = r["mode"];
    const mode: RoutingMode =
      typeof rawMode === "string" && VALID_MODES.has(rawMode as RoutingMode)
        ? (rawMode as RoutingMode)
        : "always-claude";

    const localLlm =
      r["localLlm"] && typeof r["localLlm"] === "object"
        ? (r["localLlm"] as Record<string, unknown>)
        : {};
    const baseUrl =
      typeof localLlm["baseUrl"] === "string"
        ? localLlm["baseUrl"]
        : "http://localhost:11434/v1";
    const model = typeof localLlm["model"] === "string" ? localLlm["model"] : "";

    const routingConfig: RoutingConfig = { mode, localLlm: { baseUrl, model } };

    const configPath = findConfigFile() ?? undefined;
    writeRoutingConfig(routingConfig, configPath);

    // Update in-memory config for the running process
    const { config } = await getServices();
    config.routing = routingConfig;

    return NextResponse.json({ routing: routingConfig });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write routing config" },
      { status: 500 },
    );
  }
}

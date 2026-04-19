import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  LocalProjectConfigSchema,
  loadGlobalConfig,
  loadLocalProjectConfigDetailed,
  type LocalProjectConfig,
} from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

const IDENTITY_FIELDS = new Set(["projectId", "path", "storageKey", "repo", "defaultBranch"]);

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringifyYamlValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null) return "null";
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => `${pad}- ${stringifyYamlValue(item, indent + 2).replace(/^\s+/, "")}`)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return "{}";
    return entries
      .map(([key, entry]) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          return `${pad}${key}:\n${stringifyYamlValue(entry, indent + 2)}`;
        }
        if (Array.isArray(entry) && entry.length > 0) {
          return `${pad}${key}:\n${stringifyYamlValue(entry, indent + 2)}`;
        }
        return `${pad}${key}: ${stringifyYamlValue(entry, indent + 2)}`;
      })
      .join("\n");
  }
  return '""';
}

function stringifyLocalProjectConfig(config: LocalProjectConfig): string {
  return `${stringifyYamlValue(config)}\n`;
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const frozen = Object.keys(body).filter((key) => IDENTITY_FIELDS.has(key));
  if (frozen.length > 0) {
    return NextResponse.json(
      { error: `Identity fields are frozen: ${frozen.join(", ")}` },
      { status: 400 },
    );
  }

  const globalConfig = loadGlobalConfig();
  const entry = globalConfig?.projects[id];
  if (!entry) {
    return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
  }

  const localConfigResult = loadLocalProjectConfigDetailed(entry.path);
  if (localConfigResult.kind === "malformed" || localConfigResult.kind === "invalid") {
    return NextResponse.json({ error: localConfigResult.error }, { status: 400 });
  }
  if (localConfigResult.kind === "old-format") {
    return NextResponse.json({ error: localConfigResult.error }, { status: 400 });
  }

  const currentConfig: LocalProjectConfig = localConfigResult.kind === "loaded" ? { ...localConfigResult.config } : {};
  const nextConfig: LocalProjectConfig = {
    ...currentConfig,
    agent: sanitizeString(body["agent"]),
    runtime: sanitizeString(body["runtime"]),
    tracker:
      body["tracker"] && typeof body["tracker"] === "object"
        ? (body["tracker"] as LocalProjectConfig["tracker"])
        : undefined,
    scm:
      body["scm"] && typeof body["scm"] === "object"
        ? (body["scm"] as LocalProjectConfig["scm"])
        : undefined,
    reactions:
      body["reactions"] && typeof body["reactions"] === "object"
        ? (body["reactions"] as LocalProjectConfig["reactions"])
        : undefined,
  };

  const validated = LocalProjectConfigSchema.parse(nextConfig);
  const configPath = path.join(entry.path, "agent-orchestrator.yaml");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, stringifyLocalProjectConfig(validated));

  return NextResponse.json({ ok: true });
}

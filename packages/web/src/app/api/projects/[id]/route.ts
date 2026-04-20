import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  LocalProjectConfigSchema,
  getProjectBaseDir,
  getGlobalConfigPath,
  loadConfig,
  loadGlobalConfig,
  loadLocalProjectConfigDetailed,
  repairWrappedLocalProjectConfig,
  unregisterProject,
  type LocalProjectConfig,
} from "@aoagents/ao-core";
import { revalidatePath } from "next/cache";
import { getServices, invalidatePortfolioServicesCache } from "@/lib/services";

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

function revalidateProjectPaths(projectId: string): void {
  for (const route of ["/", "/orchestrators", "/prs", `/projects/${projectId}`]) {
    try {
      revalidatePath(route);
    } catch {
      // Route tests do not run inside a full Next.js revalidation context.
    }
  }
}

type CleanupWorkspacePlugin = {
  list?: (projectId: string) => Promise<Array<{ path: string }>>;
  destroy?: (workspacePath: string) => Promise<void>;
};

async function cleanupManagedWorkspaces(projectId: string, workspacePluginName: string): Promise<void> {
  const { registry } = await getServices();
  const workspacePlugin = registry.get<CleanupWorkspacePlugin>("workspace", workspacePluginName);
  if (!workspacePlugin?.list || !workspacePlugin.destroy) return;

  const workspaces = await workspacePlugin.list(projectId);
  for (const workspace of workspaces) {
    await workspacePlugin.destroy(workspace.path);
  }
}

function getProjectState(projectId: string) {
  const globalConfig = loadGlobalConfig();
  const config = loadConfig(getGlobalConfigPath());
  return {
    config,
    globalEntry: globalConfig?.projects[projectId] ?? null,
    project: config.projects[projectId] ?? null,
    degradedProject: config.degradedProjects[projectId] ?? null,
  };
}

function degradedPayload(projectId: string, degradedProject: NonNullable<ReturnType<typeof getProjectState>["degradedProject"]>) {
  return {
    error: degradedProject.resolveError,
    projectId,
    degraded: true,
    project: {
      id: projectId,
      name: projectId,
      path: degradedProject.path,
      storageKey: degradedProject.storageKey,
      resolveError: degradedProject.resolveError,
    },
  };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }

    if (state.degradedProject) {
      return NextResponse.json(degradedPayload(id, state.degradedProject), { status: 200 });
    }

    return NextResponse.json(
      {
        project: {
          id,
          name: state.project?.name ?? id,
          path: state.globalEntry?.path ?? state.project?.path,
          storageKey: state.globalEntry?.storageKey ?? state.project?.storageKey,
          repo:
            (state.globalEntry?.repo &&
            typeof state.globalEntry.repo === "object" &&
            "owner" in state.globalEntry.repo &&
            "name" in state.globalEntry.repo
              ? `${state.globalEntry.repo.owner}/${state.globalEntry.repo.name}`
              : undefined) ?? "",
          defaultBranch: state.globalEntry?.defaultBranch ?? "main",
          agent: state.project?.agent,
          runtime: state.project?.runtime,
          tracker: state.project?.tracker,
          scm: state.project?.scm,
          reactions: state.project?.reactions,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load project" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
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

    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }
    if (state.degradedProject) {
      return NextResponse.json(degradedPayload(id, state.degradedProject), { status: 409 });
    }
    const projectPath = state.globalEntry?.path;
    if (!projectPath) {
      return NextResponse.json({ error: `Project "${id}" is missing a registry path.` }, { status: 409 });
    }

    const localConfigResult = loadLocalProjectConfigDetailed(projectPath);
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
    const configPath = path.join(projectPath, "agent-orchestrator.yaml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, stringifyLocalProjectConfig(validated));
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update project" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  return PATCH(request, context);
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }

    const workspacePluginName = state.project?.workspace ?? state.config.defaults.workspace ?? "worktree";
    await cleanupManagedWorkspaces(id, workspacePluginName);

    const storageKey = state.globalEntry?.storageKey ?? state.degradedProject?.storageKey ?? null;
    const otherStorageOwners = storageKey
      ? Object.entries(loadGlobalConfig(getGlobalConfigPath())?.projects ?? {}).filter(
          ([projectId, entry]) => projectId !== id && entry.storageKey === storageKey,
        )
      : [];

    if (storageKey && otherStorageOwners.length === 0) {
      rmSync(getProjectBaseDir(storageKey), { recursive: true, force: true });
    }
    unregisterProject(id);
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({
      ok: true,
      projectId: id,
      storageKey,
      removedStorageDir: Boolean(storageKey) && otherStorageOwners.length === 0,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete project" },
      { status: 500 },
    );
  }
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const state = getProjectState(id);
    if (!state.globalEntry && !state.project && !state.degradedProject) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }
    if (!state.degradedProject) {
      return NextResponse.json({ error: "Project does not need repair." }, { status: 400 });
    }

    const isWrappedConfigError = state.degradedProject.resolveError.includes("wrapped projects: format");
    if (!isWrappedConfigError) {
      return NextResponse.json(
        { error: "Automatic repair is not available for this degraded config." },
        { status: 400 },
      );
    }

    repairWrappedLocalProjectConfig(id, state.degradedProject.path);
    invalidatePortfolioServicesCache();
    revalidateProjectPaths(id);

    return NextResponse.json({ ok: true, repaired: true, projectId: id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to repair project" },
      { status: 500 },
    );
  }
}

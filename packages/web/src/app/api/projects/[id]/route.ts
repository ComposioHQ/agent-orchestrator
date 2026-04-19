import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  configToYaml,
  getPortfolio,
  isPortfolioEnabled,
  loadGlobalConfig,
  loadLocalProjectConfigDetailed,
  loadPreferences,
  syncProjectShadow,
  updatePreferences,
  unregisterProject,
} from "@aoagents/ao-core";
import { UpdateProjectBehaviorSchema, UpdateProjectPrefsSchema } from "@/lib/api-schemas";
import { invalidateProjectCaches } from "@/lib/project-registration";
import { reloadServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const IDENTITY_FIELD_KEYS = new Set(["name", "path", "sessionPrefix", "storageKey", "_shadowSyncedAt"]);

function getShadowBehaviorFields(entry: Record<string, unknown>): Record<string, unknown> {
  const {
    name: _name,
    path: _path,
    sessionPrefix: _sessionPrefix,
    storageKey: _storageKey,
    _shadowSyncedAt: _shadowSyncedAt,
    ...behaviorFields
  } = entry;
  void _name;
  void _path;
  void _sessionPrefix;
  void _storageKey;
  void _shadowSyncedAt;
  return behaviorFields;
}

function removeProjectFromPreferences(
  preferences: {
    projects?: Record<string, { pinned?: boolean; enabled?: boolean; displayName?: string }>;
    projectOrder?: string[];
    defaultProjectId?: string;
  },
  projectId: string,
) {
  if (preferences.projects?.[projectId]) {
    const { [projectId]: _removedProject, ...remainingProjects } = preferences.projects;
    preferences.projects =
      Object.keys(remainingProjects).length > 0 ? remainingProjects : undefined;
  }

  if (preferences.projectOrder) {
    const nextProjectOrder = preferences.projectOrder.filter((id) => id !== projectId);
    preferences.projectOrder = nextProjectOrder.length > 0 ? nextProjectOrder : undefined;
  }

  if (preferences.defaultProjectId === projectId) {
    preferences.defaultProjectId = undefined;
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json({ error: "Portfolio mode is disabled" }, { status: 404 });
    }

    const { id } = await context.params;
    const portfolio = getPortfolio();
    const project = portfolio.find((entry) => entry.id === id);

    if (!project) {
      return NextResponse.json({ error: `Project "${id}" not found` }, { status: 404 });
    }

    const body = await request.json();
    const parsed = UpdateProjectPrefsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid project preferences" },
        { status: 400 },
      );
    }

    updatePreferences((preferences) => {
      preferences.projects ??= {};
      preferences.projects[id] = {
        ...preferences.projects[id],
        ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
        ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
      };
    });
    invalidateProjectCaches();
    await reloadServices();

    const updatedPrefs = loadPreferences();
    return NextResponse.json({
      ok: true,
      project: {
        id,
        ...updatedPrefs.projects?.[id],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update project" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json({ error: "Portfolio mode is disabled" }, { status: 404 });
    }

    const { id } = await context.params;
    const portfolio = getPortfolio();
    const project = portfolio.find((entry) => entry.id === id);

    if (!project) {
      return NextResponse.json({ error: `Project "${id}" not found` }, { status: 404 });
    }

    const rawBody = (await request.json()) as Record<string, unknown>;
    const forbiddenField = Object.keys(rawBody).find((key) => IDENTITY_FIELD_KEYS.has(key));
    if (forbiddenField) {
      return NextResponse.json(
        { error: `Field "${forbiddenField}" is identity-owned and cannot be edited here` },
        { status: 400 },
      );
    }

    const parsed = UpdateProjectBehaviorSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid project behavior" },
        { status: 400 },
      );
    }

    const globalConfig = loadGlobalConfig();
    if (!globalConfig) {
      return NextResponse.json({ error: "Global config not found" }, { status: 404 });
    }

    const existing = globalConfig.projects[project.configProjectKey];
    if (!existing) {
      return NextResponse.json(
        { error: `Project "${project.configProjectKey}" not found in global config` },
        { status: 404 },
      );
    }

    const localConfigResult = loadLocalProjectConfigDetailed(existing.path);
    if (localConfigResult.kind === "old-format" || localConfigResult.kind === "malformed" || localConfigResult.kind === "invalid") {
      return NextResponse.json(
        { error: localConfigResult.error ?? "Local project config must be repaired before editing behavior" },
        { status: 409 },
      );
    }

    const nextLocalConfig = {
      ...(localConfigResult.kind === "loaded" && localConfigResult.config
        ? localConfigResult.config
        : getShadowBehaviorFields(existing)),
      ...parsed.data,
    };
    const localConfigPath = join(existing.path, "agent-orchestrator.yaml");
    await writeFile(localConfigPath, configToYaml(nextLocalConfig), "utf-8");
    syncProjectShadow(project.configProjectKey, nextLocalConfig);

    invalidateProjectCaches();
    await reloadServices();

    return NextResponse.json({
      ok: true,
      project: {
        id,
        configProjectKey: project.configProjectKey,
        ...parsed.data,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update project behavior" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    if (!isPortfolioEnabled()) {
      return NextResponse.json({ error: "Portfolio mode is disabled" }, { status: 404 });
    }

    const { id } = await context.params;
    const portfolio = getPortfolio();
    const project = portfolio.find((entry) => entry.id === id);

    if (!project) {
      return NextResponse.json({ error: `Project "${id}" not found` }, { status: 404 });
    }

    unregisterProject(id);
    updatePreferences((preferences) => {
      removeProjectFromPreferences(preferences, id);
    });

    invalidateProjectCaches();
    await reloadServices();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove project" },
      { status: 500 },
    );
  }
}

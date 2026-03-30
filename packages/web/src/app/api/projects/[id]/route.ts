import { NextResponse } from "next/server";
import {
  getPortfolio,
  loadPreferences,
  savePreferences,
  unregisterProject,
} from "@composio/ao-core";
import { UpdateProjectPrefsSchema } from "@/lib/api-schemas";
import { invalidatePortfolioCache } from "@/lib/project-registration";

export const dynamic = "force-dynamic";

function cleanPreferences(projectId: string, removeProject = false) {
  const preferences = loadPreferences();

  if (removeProject) {
    if (preferences.projects) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete preferences.projects[projectId];
      if (Object.keys(preferences.projects).length === 0) {
        delete preferences.projects;
      }
    }
    if (preferences.projectOrder) {
      preferences.projectOrder = preferences.projectOrder.filter((id) => id !== projectId);
      if (preferences.projectOrder.length === 0) {
        delete preferences.projectOrder;
      }
    }
    if (preferences.defaultProjectId === projectId) {
      delete preferences.defaultProjectId;
    }
  }

  return preferences;
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
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

    const preferences = loadPreferences();
    preferences.projects ??= {};
    preferences.projects[id] = {
      ...preferences.projects[id],
      ...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
    };

    savePreferences(preferences);
    invalidatePortfolioCache();

    return NextResponse.json({
      ok: true,
      project: {
        id,
        ...preferences.projects[id],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update project" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const portfolio = getPortfolio();
    const project = portfolio.find((entry) => entry.id === id);

    if (!project) {
      return NextResponse.json({ error: `Project "${id}" not found` }, { status: 404 });
    }

    if (project.source === "registered") {
      unregisterProject(id);
      const preferences = cleanPreferences(id, true);
      savePreferences(preferences);
    } else {
      const preferences = loadPreferences();
      preferences.projects ??= {};
      preferences.projects[id] = {
        ...preferences.projects[id],
        enabled: false,
        pinned: false,
      };
      if (preferences.defaultProjectId === id) {
        delete preferences.defaultProjectId;
      }
      savePreferences(preferences);
    }

    invalidatePortfolioCache();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove project" },
      { status: 500 },
    );
  }
}

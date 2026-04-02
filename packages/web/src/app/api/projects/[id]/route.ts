import { NextResponse } from "next/server";
import {
  getPortfolio,
  loadPreferences,
  updatePreferences,
  unregisterProject,
} from "@composio/ao-core";
import { UpdateProjectPrefsSchema } from "@/lib/api-schemas";
import { invalidateProjectCaches } from "@/lib/project-registration";

export const dynamic = "force-dynamic";

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

    const preferences = loadPreferences();

    return NextResponse.json({
      ok: true,
      project: {
        id,
        ...preferences.projects?.[id],
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

    unregisterProject(id);
    updatePreferences((preferences) => {
      removeProjectFromPreferences(preferences, id);
    });

    invalidateProjectCaches();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to remove project" },
      { status: 500 },
    );
  }
}

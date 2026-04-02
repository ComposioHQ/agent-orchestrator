import { NextResponse } from "next/server";
import { getPortfolio, loadPreferences, updatePreferences } from "@composio/ao-core";
import { UpdatePreferencesSchema } from "@/lib/api-schemas";
import { invalidateProjectCaches } from "@/lib/project-registration";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const parsed = UpdatePreferencesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid preferences payload" },
        { status: 400 },
      );
    }

    const portfolioIds = new Set(getPortfolio().map((project) => project.id));
    updatePreferences((preferences) => {
      if (parsed.data.projectOrder) {
        const ordered = parsed.data.projectOrder.filter((id: string) => portfolioIds.has(id));
        preferences.projectOrder = ordered.length > 0 ? ordered : undefined;
      }

      if (parsed.data.defaultProject !== undefined) {
        preferences.defaultProjectId =
          parsed.data.defaultProject && portfolioIds.has(parsed.data.defaultProject)
            ? parsed.data.defaultProject
            : undefined;
      }
    });
    invalidateProjectCaches();

    const preferences = loadPreferences();

    return NextResponse.json({
      ok: true,
      preferences: {
        defaultProjectId: preferences.defaultProjectId,
        projectOrder: preferences.projectOrder ?? [],
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save preferences" },
      { status: 500 },
    );
  }
}

import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

export async function refreshProjectsView(router?: AppRouterInstance): Promise<void> {
  try {
    await fetch("/api/projects/reload", { method: "POST" });
  } catch {
    // Best-effort: route refresh below is the real UX fallback.
  }

  router?.refresh();
}

import type { OrchestratorConfig } from "@composio/ao-core";

export type RuntimeSelectionSource = "flag" | "project" | "default";

export interface RuntimeSelection {
  name: string;
  source: RuntimeSelectionSource;
}

export function getRuntimeSelection(
  config: Pick<OrchestratorConfig, "defaults" | "projects">,
  projectId: string,
  runtimeOverride?: string,
): RuntimeSelection {
  const project = config.projects[projectId];
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  if (runtimeOverride) {
    return { name: runtimeOverride, source: "flag" };
  }
  if (project.runtime) {
    return { name: project.runtime, source: "project" };
  }
  return { name: config.defaults.runtime, source: "default" };
}

export function formatRuntimeSelection(selection: RuntimeSelection): string {
  switch (selection.source) {
    case "flag":
      return `${selection.name} (--runtime)`;
    case "project":
      return `${selection.name} (project config)`;
    case "default":
    default:
      return `${selection.name} (defaults.runtime)`;
  }
}

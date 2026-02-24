import type { ProjectConfig } from "./types.js";

export interface InputSourceConfig {
  type: "linear" | "generic";
  token?: string;
  url?: string;
  auth?: { type: "bearer"; token: string };
  toolMap?: Record<string, unknown>;
}

export interface ResolvedSource {
  name: string;
  config: InputSourceConfig | null;
}

/**
 * Resolve which input source to use for a project.
 *
 * Returns the source name and its config (if configured).
 * The caller is responsible for instantiating the concrete McpInputSource.
 */
export function resolveInputSource(
  project: ProjectConfig,
  sourceName: string | null,
): ResolvedSource {
  const name = sourceName ?? project.defaultInputSource ?? "linear";
  const sourceConfig = project.inputSources?.[name] ?? null;

  return { name, config: sourceConfig };
}

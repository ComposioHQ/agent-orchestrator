import type { ProjectConfig, RuntimeHandle } from "./types.js";
import { safeJsonParse } from "./utils/validation.js";

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeRuntimeConfig(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!base && !override) return undefined;

  const merged: Record<string, unknown> = {};

  for (const source of [base, override]) {
    if (!source) continue;

    for (const [key, value] of Object.entries(source)) {
      const existing = merged[key];
      merged[key] =
        isPlainObject(existing) && isPlainObject(value)
          ? mergeRuntimeConfig(existing, value)
          : isPlainObject(value)
            ? (mergeRuntimeConfig(value) ?? {})
            : value;
    }
  }

  return merged;
}

export function parseStoredRuntimeHandle(raw?: Record<string, string>): RuntimeHandle | null {
  if (!raw?.["runtimeHandle"]) return null;
  return safeJsonParse<RuntimeHandle>(raw["runtimeHandle"]) ?? null;
}

export function parseStoredRuntimeConfig(
  raw?: Record<string, string>,
): Record<string, unknown> | undefined {
  if (!raw?.["runtimeConfig"]) return undefined;
  const parsed = safeJsonParse<Record<string, unknown>>(raw["runtimeConfig"]);
  return isPlainObject(parsed) ? parsed : undefined;
}

export function resolveRuntimeName(
  project: Pick<ProjectConfig, "runtime">,
  defaultRuntime: string,
  options?: {
    raw?: Record<string, string>;
    runtimeOverride?: string;
  },
): string {
  const parsedHandle = parseStoredRuntimeHandle(options?.raw);

  return (
    options?.runtimeOverride ??
    parsedHandle?.runtimeName ??
    options?.raw?.["runtime"] ??
    project.runtime ??
    defaultRuntime
  );
}

export function resolveRuntimeConfigForSpawn(
  project: Pick<ProjectConfig, "runtimeConfig">,
  runtimeConfigOverride?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return mergeRuntimeConfig(project.runtimeConfig, runtimeConfigOverride);
}

export function resolveRuntimeConfigForSession(
  project: Pick<ProjectConfig, "runtimeConfig">,
  raw: Record<string, string>,
): Record<string, unknown> | undefined {
  const stored = parseStoredRuntimeConfig(raw);
  return stored ? mergeRuntimeConfig(stored) : mergeRuntimeConfig(project.runtimeConfig);
}

import type { OrchestratorConfig, ProjectConfig } from "@composio/ao-core";
import { mergeRuntimeConfig, isPlainObject } from "@composio/ao-core";

export interface RuntimeOverrideFlagOptions {
  runtime?: string;
  runtimeConfig?: string;
  runtimeImage?: string;
  runtimeCpus?: string;
  runtimeMemory?: string;
  runtimeGpus?: string;
  runtimeReadOnly?: boolean;
  runtimeNetwork?: string;
  runtimeCapDrop?: string[];
  runtimeTmpfs?: string[];
}

export interface RuntimeOverride {
  runtime?: string;
  runtimeConfig?: Record<string, unknown>;
  effectiveRuntime: string;
  effectiveRuntimeConfig?: Record<string, unknown>;
}

function parseRuntimeConfigOverride(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid --runtime-config JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error("--runtime-config must be a JSON object.");
  }

  return parsed;
}

function trimOrUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimStringList(values?: string[]): string[] | undefined {
  const trimmed = values?.map((value) => value.trim()).filter((value) => value.length > 0);
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function appendStringOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function resolveRuntimeOverride(
  config: OrchestratorConfig,
  project: ProjectConfig,
  opts: RuntimeOverrideFlagOptions,
): RuntimeOverride {
  const runtime = trimOrUndefined(opts.runtime);
  const baseRuntimeConfig = parseRuntimeConfigOverride(opts.runtimeConfig);
  const limitOverrides: Record<string, unknown> = {};

  if (trimOrUndefined(opts.runtimeCpus)) {
    limitOverrides.cpus = trimOrUndefined(opts.runtimeCpus);
  }
  if (trimOrUndefined(opts.runtimeMemory)) {
    limitOverrides.memory = trimOrUndefined(opts.runtimeMemory);
  }
  if (trimOrUndefined(opts.runtimeGpus)) {
    limitOverrides.gpus = trimOrUndefined(opts.runtimeGpus);
  }

  const flagRuntimeConfig = {
    ...(trimOrUndefined(opts.runtimeImage) ? { image: trimOrUndefined(opts.runtimeImage) } : {}),
    ...(trimOrUndefined(opts.runtimeNetwork)
      ? { network: trimOrUndefined(opts.runtimeNetwork) }
      : {}),
    ...(opts.runtimeReadOnly ? { readOnlyRoot: true } : {}),
    ...(trimStringList(opts.runtimeCapDrop)
      ? { capDrop: trimStringList(opts.runtimeCapDrop) }
      : {}),
    ...(trimStringList(opts.runtimeTmpfs) ? { tmpfs: trimStringList(opts.runtimeTmpfs) } : {}),
    ...(Object.keys(limitOverrides).length > 0 ? { limits: limitOverrides } : {}),
  };

  const runtimeConfig = mergeRuntimeConfig(
    baseRuntimeConfig,
    Object.keys(flagRuntimeConfig).length > 0 ? flagRuntimeConfig : undefined,
  );
  const effectiveRuntime = runtime ?? project.runtime ?? config.defaults.runtime ?? "tmux";
  const effectiveRuntimeConfig = mergeRuntimeConfig(project.runtimeConfig, runtimeConfig);

  return {
    runtime,
    runtimeConfig,
    effectiveRuntime,
    effectiveRuntimeConfig,
  };
}

import { statSync } from "node:fs";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";

type ConfigCacheEntry = {
  config: OrchestratorConfig;
  configPathEnv: string | null;
  mtimeMs: number | null;
};

const globalForConfigCache = globalThis as typeof globalThis & {
  _aoConfigCache?: ConfigCacheEntry;
};

function getConfigMtime(config: OrchestratorConfig): number | null {
  try {
    return statSync(config.configPath).mtimeMs;
  } catch {
    return null;
  }
}

export function getCachedConfig(): OrchestratorConfig {
  const configPathEnv = process.env.AO_CONFIG_PATH ?? null;
  const cached = globalForConfigCache._aoConfigCache;

  if (cached) {
    const currentMtime = getConfigMtime(cached.config);
    if (cached.configPathEnv === configPathEnv && cached.mtimeMs === currentMtime) {
      return cached.config;
    }
  }

  const config = loadConfig();
  globalForConfigCache._aoConfigCache = {
    config,
    configPathEnv,
    mtimeMs: getConfigMtime(config),
  };
  return config;
}

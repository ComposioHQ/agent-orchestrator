/**
 * Multi-project registration and sync logic for `ao start`.
 *
 * Pure functions that handle project registration, shadow sync, and
 * config building without any CLI dependencies (no chalk, no console).
 * The CLI command wraps these with user-facing output.
 */

import { resolve, basename, dirname } from "node:path";
import type { OrchestratorConfig } from "./types.js";
import {
  type GlobalProjectEntry,
  loadGlobalConfig,
  saveGlobalConfig,
  registerProject,
  detectConfigMode,
  findLocalConfigPath,
  loadLocalProjectConfig,
  syncShadow,
  matchProjectByCwd,
  findGlobalConfigPath,
} from "./global-config.js";
import { buildEffectiveConfig } from "./migration.js";
import { generateSessionPrefix, generateProjectId, expandHome } from "./paths.js";

export interface MultiProjectStartResult {
  config: OrchestratorConfig;
  projectId: string;
  /** Messages for the CLI to display (type + text) */
  messages: Array<{ level: "info" | "warn" | "success"; text: string }>;
}

/**
 * Core logic for multi-project registration and shadow sync.
 *
 * Returns null if no global config exists (caller should fall back to
 * legacy single-file flow).
 */
export function resolveMultiProjectStart(
  workingDir: string,
): MultiProjectStartResult | null {
  const resolvedDir = resolve(workingDir);
  const messages: MultiProjectStartResult["messages"] = [];

  // Load global config
  let globalConfig = loadGlobalConfig();
  if (!globalConfig) {
    return null;
  }

  // 3. Match CWD to a registered project
  let projectId = matchProjectByCwd(globalConfig, resolvedDir);

  if (!projectId) {
    // Walk up from CWD to find a local config
    let searchDir = resolvedDir;
    let localPath: string | null = null;
    while (searchDir !== dirname(searchDir)) {
      localPath = findLocalConfigPath(searchDir);
      if (localPath) break;
      searchDir = dirname(searchDir);
    }
    const projectRoot = localPath ? searchDir : resolvedDir;

    if (localPath) {
      // Auto-register in hybrid mode
      let derivedId = generateSessionPrefix(generateProjectId(projectRoot));

      // Handle collision
      if (globalConfig.projects[derivedId]) {
        const existing = globalConfig.projects[derivedId];
        if (resolve(expandHome(existing.path)) !== projectRoot) {
          let suffix = 2;
          let altId = `${derivedId}${suffix}`;
          while (globalConfig.projects[altId]) {
            suffix++;
            altId = `${derivedId}${suffix}`;
          }
          messages.push({ level: "warn", text: `ID "${derivedId}" taken, using "${altId}"` });
          derivedId = altId;
        }
      }
      projectId = derivedId;

      const entry: GlobalProjectEntry = {
        name: basename(projectRoot),
        path: projectRoot,
      };
      globalConfig = registerProject(globalConfig, projectId, entry);

      // Sync shadow
      try {
        const localConfig = loadLocalProjectConfig(localPath);
        const { config: synced, excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
        globalConfig = synced;
        if (excludedSecrets.length > 0) {
          messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
        }
      } catch (err) {
        messages.push({ level: "warn", text: `Could not sync local config: ${err instanceof Error ? err.message : String(err)}` });
      }

      saveGlobalConfig(globalConfig);
      messages.push({ level: "success", text: `Registered project "${projectId}" (hybrid mode)` });
      messages.push({ level: "success", text: "Shadow synced" });
    } else {
      return null;
    }
  } else {
    // Already registered — sync shadow if hybrid
    const registeredPath = expandHome(globalConfig.projects[projectId].path);
    const mode = detectConfigMode(registeredPath);
    if (mode === "hybrid") {
      const localPath = findLocalConfigPath(registeredPath);
      if (localPath) {
        try {
          const localConfig = loadLocalProjectConfig(localPath);
          const { config: synced, excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
          globalConfig = synced;
          saveGlobalConfig(globalConfig);
          if (excludedSecrets.length > 0) {
            messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
          }
        } catch (err) {
          messages.push({ level: "warn", text: `Shadow sync failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }

  // 4. Build effective config
  const globalPath = findGlobalConfigPath();
  const effectiveConfig = buildEffectiveConfig(globalConfig, globalPath);

  return { config: effectiveConfig, projectId, messages };
}

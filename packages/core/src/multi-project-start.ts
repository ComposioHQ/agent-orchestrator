/**
 * Multi-project registration and sync logic for `ao start`.
 *
 * Pure functions that handle project registration, shadow sync, and
 * config building without any CLI dependencies (no chalk, no console).
 * The CLI command wraps these with user-facing output.
 */

import { resolve, basename } from "node:path";
import type { OrchestratorConfig } from "./types.js";
import {
  type GlobalProjectEntry,
  loadGlobalConfig,
  saveGlobalConfig,
  registerProject,
  detectConfigMode,
  findLocalConfigPath,
  findLocalConfigUpwards,
  loadLocalProjectConfig,
  syncShadow,
  loadShadowFile,
  saveShadowFile,
  matchProjectByCwd,
  findGlobalConfigPath,
} from "./global-config.js";
import { buildEffectiveConfig } from "./migration.js";
import { generateSessionPrefix, generateProjectId, expandHome } from "./paths.js";
import { applyGlobalConfigPipeline } from "./config.js";

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
  let isNewRegistration = false;

  if (!projectId) {
    const found = findLocalConfigUpwards(resolvedDir);
    const localPath = found?.configPath ?? null;
    const projectRoot = found?.projectRoot ?? resolvedDir;

    if (localPath) {
      // Auto-register in hybrid mode
      let derivedId = generateSessionPrefix(generateProjectId(projectRoot));
      const originalDerivedId = derivedId;

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
      isNewRegistration = true;

      // Sync shadow
      try {
        const localConfig = loadLocalProjectConfig(localPath);
        const { config: synced, excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
        globalConfig = synced;
        if (excludedSecrets.length > 0) {
          messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
        }
        messages.push({ level: "success", text: "Shadow synced" });
      } catch (err) {
        messages.push({ level: "warn", text: `Could not sync local config: ${err instanceof Error ? err.message : String(err)}` });
      }

      // If the ID was suffixed to resolve a collision (e.g. "ao" → "ao2"), the session
      // prefix would still be re-derived from basename(path) by applyProjectDefaults,
      // producing the same prefix as the original project ("ao" for both).
      // Write the suffixed prefix explicitly to the shadow so applyProjectDefaults
      // uses it instead of re-deriving from the path.
      if (derivedId !== originalDerivedId) {
        const currentShadow = loadShadowFile(projectId) ?? {};
        saveShadowFile(projectId, { ...currentShadow, sessionPrefix: generateSessionPrefix(projectId) });
      }

      messages.push({ level: "success", text: `Registered project "${projectId}" (hybrid mode)` });
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
          // syncShadow writes to the shadow file and returns globalConfig unchanged.
          // No need to saveGlobalConfig — the global registry entry is unmodified.
          const { excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
          if (excludedSecrets.length > 0) {
            messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
          }
        } catch (err) {
          messages.push({ level: "warn", text: `Shadow sync failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    }
  }

  // 4. Build effective config via the shared pipeline (single source of truth in config.ts).
  // validateProjectUniqueness runs inside applyGlobalConfigPipeline — run this BEFORE
  // saveGlobalConfig so that a session prefix collision throws before the broken state
  // is persisted to disk.
  const globalPath = findGlobalConfigPath();
  const buildWarnings: string[] = [];
  const built = buildEffectiveConfig(globalConfig, globalPath, buildWarnings);
  for (const w of buildWarnings) {
    messages.push({ level: "warn", text: w });
  }
  const effectiveConfig = applyGlobalConfigPipeline(built);

  // 5. Persist only after validation passes (new registrations only — already-registered
  //    projects don't modify globalConfig so nothing to save).
  if (isNewRegistration) {
    saveGlobalConfig(globalConfig);
  }

  return { config: effectiveConfig, projectId, messages };
}

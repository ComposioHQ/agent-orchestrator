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
  matchProjectByCwd,
  findGlobalConfigPath,
} from "./global-config.js";
import { generateSessionPrefix, generateProjectId, expandHome } from "./paths.js";
import { buildConfigFromGlobal } from "./config.js";

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
    const found = findLocalConfigUpwards(resolvedDir);
    const localPath = found?.configPath ?? null;
    const projectRoot = found?.projectRoot ?? resolvedDir;

    if (localPath) {
      // Reject if any existing project shares the same directory basename.
      // validateProjectUniqueness checks basename(project.path) uniqueness, so
      // two projects at e.g. /work/app and /personal/app would break config loading.
      const newBasename = basename(projectRoot);
      const basenameConflict = Object.entries(globalConfig.projects).find(
        ([, existing]) =>
          basename(expandHome(existing.path)) === newBasename &&
          resolve(expandHome(existing.path)) !== projectRoot,
      );
      if (basenameConflict) {
        const [conflictId, conflictEntry] = basenameConflict;
        // Throw rather than returning null+messages: null discards messages because
        // the caller checks `if (!result) return null` before printing them.
        throw new Error(
          `Cannot register "${newBasename}": directory basename conflicts with project "${conflictId}" (${conflictEntry.path}). Rename the directory to use a unique name.`,
        );
      }

      // Auto-register in hybrid mode
      let derivedId = generateSessionPrefix(generateProjectId(projectRoot));

      // Handle collision
      let idSuffixed = false;
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
          idSuffixed = true;
        }
      }
      projectId = derivedId;

      const entry: GlobalProjectEntry = {
        name: basename(projectRoot),
        path: projectRoot,
        // When the ID was suffixed due to collision, store the derived prefix so
        // buildEffectiveConfig uses it instead of re-deriving from the path basename
        // (which would reproduce the original colliding prefix and cause
        // validateProjectUniqueness to throw on the next config load).
        ...(idSuffixed && { sessionPrefix: projectId }),
      } as GlobalProjectEntry;
      globalConfig = registerProject(globalConfig, projectId, entry);

      // Save registry first so the project entry exists even if shadow sync fails.
      // An orphan shadow file (shadow exists, no registry entry) is harder to
      // recover from than a registered project with a missing shadow file.
      saveGlobalConfig(globalConfig);
      messages.push({ level: "success", text: `Registered project "${projectId}" (hybrid mode)` });

      // Sync shadow
      try {
        const localConfig = loadLocalProjectConfig(localPath);
        const { excludedSecrets } = syncShadow(globalConfig, projectId, localConfig);
        if (excludedSecrets.length > 0) {
          messages.push({ level: "warn", text: `Excluded secret-like fields: ${excludedSecrets.join(", ")}` });
        }
        messages.push({ level: "success", text: "Shadow synced" });
      } catch (err) {
        messages.push({ level: "warn", text: `Could not sync local config: ${err instanceof Error ? err.message : String(err)}` });
      }

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
          // syncShadow writes the shadow file internally and returns the same
          // globalConfig reference unchanged — no registry save needed here.
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

  // 4. Build effective config via the single shared pipeline in config.ts
  const globalPath = findGlobalConfigPath();
  const effectiveConfig = buildConfigFromGlobal(globalConfig, globalPath);

  return { config: effectiveConfig, projectId, messages };
}

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionId, OrchestratorConfig, ProjectConfig } from "../types.js";
import { readMetadataRaw } from "../metadata.js";
import { getSessionsDir, generateConfigHash } from "../paths.js";

const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

export interface ScannedSession {
  sessionId: SessionId;
  projectId: string;
  project: ProjectConfig;
  sessionsDir: string;
  rawMetadata: Record<string, string>;
}

export function scanAllSessions(
  config: OrchestratorConfig,
  projectIdFilter?: string,
): ScannedSession[] {
  const results: ScannedSession[] = [];

  for (const [projectKey, project] of Object.entries(config.projects)) {
    if (projectIdFilter && projectKey !== projectIdFilter) continue;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    if (!existsSync(sessionsDir)) continue;

    const files = readdirSync(sessionsDir);
    for (const file of files) {
      if (file === "archive" || file.startsWith(".")) continue;

      if (!VALID_SESSION_ID.test(file)) continue;

      const fullPath = join(sessionsDir, file);
      try {
        if (!statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }

      const rawMetadata = readMetadataRaw(sessionsDir, file);
      if (!rawMetadata) continue;

      results.push({
        sessionId: file,
        projectId: projectKey,
        project,
        sessionsDir,
        rawMetadata,
      });
    }
  }

  return results;
}

export function getRecoveryLogPath(configPath: string): string {
  const hash = generateConfigHash(configPath);
  return join(homedir(), ".agent-orchestrator", hash, "recovery.log");
}

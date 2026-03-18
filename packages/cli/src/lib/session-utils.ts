import type { OrchestratorConfig, ParsedRepoUrl } from "@composio/ao-core";
import { exec, execSilent } from "./shell.js";

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check whether a session name matches a project prefix (strict: prefix-\d+ only). */
export function matchesPrefix(sessionName: string, prefix: string): boolean {
  return new RegExp(`^${escapeRegex(prefix)}-\\d+$`).test(sessionName);
}

/** Find which project a session belongs to by matching its name against session prefixes. */
export function findProjectForSession(
  config: OrchestratorConfig,
  sessionName: string,
): string | null {
  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (matchesPrefix(sessionName, prefix)) {
      return id;
    }
  }
  return null;
}

export function isOrchestratorSessionName(
  config: OrchestratorConfig,
  sessionName: string,
  projectId?: string,
): boolean {
  if (projectId) {
    const project = config.projects[projectId];
    if (project && sessionName === `${project.sessionPrefix || projectId}-orchestrator`) {
      return true;
    }
  }

  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (sessionName === `${prefix}-orchestrator`) {
      return true;
    }
  }

  return sessionName.endsWith("-orchestrator");
}

/**
 * Clone a repo with authentication support.
 *
 * Strategy:
 *   1. Try `gh repo clone owner/repo target -- --depth 1` — handles GitHub auth
 *      for private repos via the user's `gh auth` token.
 *   2. Fall back to `git clone --depth 1` with SSH URL — works for users with
 *      SSH keys configured (common for private repos without gh).
 *   3. Final fallback to `git clone --depth 1` with HTTPS URL — works for
 *      public repos without any auth setup.
 */
export async function cloneRepo(
  parsed: ParsedRepoUrl,
  targetDir: string,
  cwd: string,
): Promise<void> {
  // 1. Try gh repo clone (handles GitHub auth automatically)
  if (parsed.host === "github.com") {
    const ghAvailable = (await execSilent("gh", ["auth", "status"])) !== null;
    if (ghAvailable) {
      try {
        await exec("gh", ["repo", "clone", parsed.ownerRepo, targetDir, "--", "--depth", "1"], {
          cwd,
        });
        return;
      } catch {
        // gh clone failed — fall through to git clone with SSH
      }
    }
  }

  // 2. Try git clone with SSH URL (works with SSH keys for private repos)
  const sshUrl = `git@${parsed.host}:${parsed.ownerRepo}.git`;
  try {
    await exec("git", ["clone", "--depth", "1", sshUrl, targetDir], { cwd });
    return;
  } catch {
    // SSH failed — fall through to HTTPS
  }

  // 3. Final fallback: HTTPS (works for public repos)
  await exec("git", ["clone", "--depth", "1", parsed.cloneUrl, targetDir], { cwd });
}

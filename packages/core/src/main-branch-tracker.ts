/**
 * Main Branch Tracker — detects when a project's main branch advances.
 *
 * Caches the SHA of each project's main branch and detects when it changes.
 * In-memory only (acceptable for 30s poll cycle, resets on restart).
 */

import type { ProjectConfig, SCM } from "./types.js";

interface MainBranchState {
  projectId: string;
  sha: string;
  lastChecked: Date;
  lastAdvanced: Date | null;
}

export class MainBranchTracker {
  private states: Map<string, MainBranchState> = new Map();

  /**
   * Check if a project's main branch has advanced since last check.
   * Returns advanced=true only when SHA actually changes (debouncing).
   */
  async checkMainAdvanced(
    project: ProjectConfig,
    projectId: string,
    scm: SCM,
  ): Promise<{
    advanced: boolean;
    oldSha: string | null;
    newSha: string;
  }> {
    if (!scm.getBranchSHA) {
      return { advanced: false, oldSha: null, newSha: "" };
    }

    try {
      const newSha = await scm.getBranchSHA(project.repo, project.defaultBranch);
      const cached = this.states.get(projectId);

      if (!cached) {
        // First time checking this project — cache and return no change
        this.states.set(projectId, {
          projectId,
          sha: newSha,
          lastChecked: new Date(),
          lastAdvanced: null,
        });
        return { advanced: false, oldSha: null, newSha };
      }

      const oldSha = cached.sha;

      // Update last checked
      cached.lastChecked = new Date();

      if (newSha !== oldSha) {
        // Main branch advanced!
        cached.sha = newSha;
        cached.lastAdvanced = new Date();
        this.states.set(projectId, cached);

        return { advanced: true, oldSha, newSha };
      }

      return { advanced: false, oldSha, newSha };
    } catch {
      // Failed to check — return no change
      return { advanced: false, oldSha: null, newSha: "" };
    }
  }

  /**
   * Manually update the cached SHA for a project (used after manual rebases).
   */
  updateState(projectId: string, sha: string): void {
    const cached = this.states.get(projectId);
    if (cached) {
      cached.sha = sha;
      cached.lastChecked = new Date();
      this.states.set(projectId, cached);
    } else {
      this.states.set(projectId, {
        projectId,
        sha,
        lastChecked: new Date(),
        lastAdvanced: null,
      });
    }
  }

  /**
   * Get the cached state for a project (for debugging/inspection).
   */
  getState(projectId: string): MainBranchState | null {
    return this.states.get(projectId) ?? null;
  }
}

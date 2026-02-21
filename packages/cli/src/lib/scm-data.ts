/**
 * Shared SCM data-fetching helpers.
 *
 * Extracts the common PR detection pattern used by both `status.ts` and
 * `session.ts` (table command): metadata URL fallback → SCM detectPR.
 */

import type { Session, ProjectConfig, SCM, PRInfo } from "@composio/ao-core";

export interface PRDetectionResult {
  prNumber: number | null;
  prUrl: string;
  prInfo: PRInfo | null;
}

/**
 * Detect PR for a session using SCM plugin with metadata URL fallback.
 *
 * 1. Extracts PR number from metadata `pr` URL (e.g. `/pull/42`)
 * 2. Attempts live PR detection via SCM plugin (overwrites if found)
 * 3. Returns prInfo so callers can fetch additional data (CI, reviews, etc.)
 */
export async function detectSessionPR(
  session: Session,
  scm: SCM | null,
  project: ProjectConfig | undefined,
): Promise<PRDetectionResult> {
  let prNumber: number | null = null;
  let prUrl = "";
  let prInfo: PRInfo | null = null;

  // Extract PR number from metadata URL as fallback
  const prMetaUrl = session.metadata["pr"];
  if (prMetaUrl) {
    const match = /\/pull\/(\d+)/.exec(prMetaUrl);
    if (match) {
      prNumber = parseInt(match[1], 10);
      prUrl = prMetaUrl;
    }
  }

  // Try to detect PR via SCM
  if (scm && project) {
    try {
      prInfo = await scm.detectPR(session, project);
      if (prInfo) {
        prNumber = prInfo.number;
        prUrl = prInfo.url;
      }
    } catch {
      // SCM lookup failed — use metadata fallback
    }
  }

  return { prNumber, prUrl, prInfo };
}

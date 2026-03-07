/**
 * Learnings Manager — manages .ao/learnings/ directory.
 *
 * Project-level directory committed to the repo that accumulates
 * structured knowledge across tasks. Three categories:
 *   - conventions.md: Codebase patterns
 *   - pitfalls.md: Failures to avoid
 *   - decisions.md: Architectural choices
 *
 * Agents write via ao-learn (buffered). The refine phase applies
 * incremental changes via ao-refine commands.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LearningCategory, LearningsConfig, RefineCommand } from "@composio/ao-core";

const CATEGORY_FILES: Record<LearningCategory, string> = {
  convention: "conventions.md",
  pitfall: "pitfalls.md",
  decision: "decisions.md",
};

const CATEGORY_HEADERS: Record<LearningCategory, string> = {
  convention: "# Conventions\n\nCodebase patterns and standards.\n",
  pitfall: "# Pitfalls\n\nFailures and mistakes to avoid.\n",
  decision: "# Decisions\n\nArchitectural choices constraining future work.\n",
};

/** Initialize the .ao/learnings/ directory with empty files */
export function initLearnings(projectPath: string): void {
  const learningsDir = join(projectPath, ".ao", "learnings");
  mkdirSync(learningsDir, { recursive: true });

  for (const [category, filename] of Object.entries(CATEGORY_FILES)) {
    const filePath = join(learningsDir, filename);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, CATEGORY_HEADERS[category as LearningCategory], "utf-8");
    }
  }
}

/** Read all entries from a learnings file */
export function readLearnings(projectPath: string, category: LearningCategory): string[] {
  const filePath = join(projectPath, ".ao", "learnings", CATEGORY_FILES[category]);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  // Extract bullet-point entries (lines starting with "- ")
  return lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
}

/** Read all learnings as a combined string for skill injection */
export function readAllLearningsForInjection(projectPath: string): string {
  const learningsDir = join(projectPath, ".ao", "learnings");
  if (!existsSync(learningsDir)) return "";

  const sections: string[] = [];

  for (const [category, filename] of Object.entries(CATEGORY_FILES)) {
    const filePath = join(learningsDir, filename);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, "utf-8").trim();
    if (content && content !== CATEGORY_HEADERS[category as LearningCategory].trim()) {
      sections.push(content);
    }
  }

  return sections.join("\n\n");
}

/** Apply a set of refine commands to the learnings files */
export function applyRefineCommands(
  projectPath: string,
  commands: RefineCommand[],
  config: LearningsConfig,
): { applied: number; skipped: number; errors: string[] } {
  const result = { applied: 0, skipped: 0, errors: [] as string[] };

  for (const cmd of commands) {
    try {
      applyRefineCommand(projectPath, cmd, config);
      result.applied++;
    } catch (err) {
      result.skipped++;
      result.errors.push(
        `${cmd.action} ${cmd.category}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

/** Apply a single refine command */
function applyRefineCommand(
  projectPath: string,
  cmd: RefineCommand,
  config: LearningsConfig,
): void {
  const filePath = join(projectPath, ".ao", "learnings", CATEGORY_FILES[cmd.category]);
  if (!existsSync(filePath)) {
    throw new Error(`Learnings file not found: ${CATEGORY_FILES[cmd.category]}`);
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  switch (cmd.action) {
    case "add": {
      // Check entry cap
      const entryCount = lines.filter((l) => l.startsWith("- ")).length;
      if (entryCount >= config.maxEntriesPerFile) {
        throw new Error(
          `File ${CATEGORY_FILES[cmd.category]} is at cap (${config.maxEntriesPerFile} entries). Remove an entry before adding.`,
        );
      }

      // Check for duplicate
      const normalizedDesc = cmd.description.toLowerCase().trim();
      const isDuplicate = lines.some(
        (l) => l.startsWith("- ") && l.slice(2).toLowerCase().trim() === normalizedDesc,
      );
      if (isDuplicate) {
        throw new Error(`Duplicate entry: "${cmd.description}"`);
      }

      // Add new entry before the last empty line (or at end)
      lines.push(`- ${cmd.description}`);
      break;
    }

    case "remove": {
      const idx = lines.findIndex(
        (l) => l.startsWith("- ") && l.slice(2).trim() === cmd.description.trim(),
      );
      if (idx === -1) {
        throw new Error(`Entry not found: "${cmd.description}"`);
      }
      lines.splice(idx, 1);
      break;
    }

    case "update": {
      const idx = lines.findIndex(
        (l) => l.startsWith("- ") && l.slice(2).trim().startsWith(cmd.description.trim()),
      );
      if (idx === -1) {
        throw new Error(`Entry not found: "${cmd.description}"`);
      }
      if (cmd.append) {
        lines[idx] = `${lines[idx]} — ${cmd.append}`;
      }
      break;
    }

    case "confirm": {
      // No-op for the file content — staleness tracking is metadata-level
      break;
    }
  }

  writeFileSync(filePath, lines.join("\n"), "utf-8");
}

/** Check if learnings directory exists and is initialized */
export function hasLearnings(projectPath: string): boolean {
  const learningsDir = join(projectPath, ".ao", "learnings");
  return existsSync(learningsDir);
}

import { isAbsolute, relative, resolve } from "node:path";
import { cwd } from "node:process";
import type {
  OrchestratorConfig,
  ParsedRepoUrl,
  ProjectConfig,
} from "@aoagents/ao-core";
import { isHumanCaller } from "./caller-context.js";
import { promptSelect } from "./prompts.js";

interface ProjectWithPath {
  path: string;
}

function isWithinProject(projectPath: string, currentDir: string): boolean {
  const relativePath = relative(projectPath, currentDir);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * Find the best matching project for the current directory.
 * When multiple project paths contain the cwd, prefer the deepest match.
 */
export function findProjectForDirectory<T extends ProjectWithPath>(
  projects: Record<string, T>,
  currentDir: string,
): string | null {
  const resolvedCurrentDir = resolve(currentDir);

  const matches = Object.entries(projects)
    .filter(([, project]) => isWithinProject(resolve(project.path), resolvedCurrentDir))
    .sort(([, a], [, b]) => resolve(b.path).length - resolve(a.path).length);

  return matches[0]?.[0] ?? null;
}

/**
 * Resolve project from config.
 * If projectArg is provided, use it. If only one project exists, use that.
 * Otherwise, error with helpful message.
 */
export async function resolveProject(
  config: OrchestratorConfig,
  projectArg?: string,
  action = "start",
): Promise<{ projectId: string; project: ProjectConfig }> {
  const projectIds = Object.keys(config.projects);

  if (projectIds.length === 0) {
    throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
  }

  // Explicit project argument
  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Project "${projectArg}" not found. Available projects:\n  ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, project };
  }

  // Only one project — use it
  if (projectIds.length === 1) {
    const projectId = projectIds[0];
    return { projectId, project: config.projects[projectId] };
  }

  // Multiple projects — try matching cwd to a project path
  // Note: loadConfig() already expands ~ in project paths via expandPaths()
  const currentDir = resolve(cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, currentDir);
  if (matchedProjectId) {
    return { projectId: matchedProjectId, project: config.projects[matchedProjectId] };
  }

  // No match — prompt if interactive, otherwise error
  if (isHumanCaller()) {
    const projectId = await promptSelect(
      `Choose project to ${action}:`,
      projectIds.map((id) => ({
        value: id,
        label: config.projects[id].name ?? id,
        hint: id,
      })),
    );
    return { projectId, project: config.projects[projectId] };
  } else {
    throw new Error(
      `Multiple projects configured. Specify which one to ${action}:\n  ${projectIds.map((id) => `ao ${action} ${id}`).join("\n  ")}`,
    );
  }
}

/**
 * Resolve project from config by matching against a repo URL's ownerRepo.
 * Used when `ao start <url>` loads an existing multi-project config — the user
 * can't pass both a URL and a project name since they share the same arg slot.
 *
 * Falls back to `resolveProject` (which handles single-project configs or
 * errors with a helpful message for ambiguous multi-project cases).
 */
export async function resolveProjectByRepo(
  config: OrchestratorConfig,
  parsed: ParsedRepoUrl,
): Promise<{ projectId: string; project: ProjectConfig }> {
  const projectIds = Object.keys(config.projects);

  // Try to match by repo field (e.g. "owner/repo")
  for (const id of projectIds) {
    const project = config.projects[id];
    if (project.repo === parsed.ownerRepo) {
      return { projectId: id, project };
    }
  }

  // No repo match — fall back to standard resolution (works for single-project)
  return await resolveProject(config);
}

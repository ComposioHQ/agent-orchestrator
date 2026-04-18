import { homedir } from "node:os";
import { delimiter, isAbsolute, relative, resolve } from "node:path";

const WORKSPACE_ROOTS_ENV = "AO_ALLOWED_WORKSPACE_ROOTS";

function parseAllowedWorkspaceRoots(): string[] {
  const configured = process.env[WORKSPACE_ROOTS_ENV]
    ?.split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (configured && configured.length > 0) {
    return configured.map((entry) => resolve(entry));
  }

  return Array.from(new Set([resolve(homedir()), resolve(process.cwd())]));
}

export function getAllowedWorkspaceRoots(): string[] {
  return parseAllowedWorkspaceRoots();
}

export function isWorkspacePathAllowed(targetPath: string): boolean {
  const resolvedTargetPath = resolve(targetPath);

  return getAllowedWorkspaceRoots().some((rootPath) => {
    const pathFromRoot = relative(rootPath, resolvedTargetPath);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });
}

export function resolveWorkspaceBrowsePath(targetPath?: string | null): { resolvedPath: string; rootPath: string } {
  const allowedRoots = getAllowedWorkspaceRoots();
  const resolvedTargetPath =
    typeof targetPath === "string" && targetPath.trim().length > 0
      ? resolve(targetPath)
      : allowedRoots[0];

  const rootPath = allowedRoots.find((candidateRoot) => {
    const pathFromRoot = relative(candidateRoot, resolvedTargetPath);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });

  if (!rootPath) {
    throw new Error("Access denied: Directory must be inside an allowed workspace root");
  }

  return { resolvedPath: resolvedTargetPath, rootPath };
}

export function assertWorkspacePathAllowed(targetPath: string, label = "path"): string {
  const resolvedTargetPath = resolve(targetPath);
  if (!isWorkspacePathAllowed(resolvedTargetPath)) {
    throw new Error(`Access denied: ${label} must be inside an allowed workspace root`);
  }
  return resolvedTargetPath;
}

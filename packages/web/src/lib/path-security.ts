import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export function isWithinDirectory(parentPath: string, childPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function getHomePath(): Promise<string> {
  return realpath(homedir()).catch(() => resolve(homedir()));
}

export async function resolveHomeScopedPath(rawPath?: string | null): Promise<{
  homePath: string;
  resolvedPath: string;
}> {
  const homePath = await getHomePath();
  const requestedPath = rawPath
    ? isAbsolute(rawPath)
      ? rawPath
      : join(homePath, rawPath)
    : homePath;

  const resolvedPath = await realpath(resolve(requestedPath)).catch(() => resolve(requestedPath));
  return { homePath, resolvedPath };
}

export async function assertPathWithinHome(rawPath?: string | null): Promise<string> {
  const { homePath, resolvedPath } = await resolveHomeScopedPath(rawPath);
  if (!isWithinDirectory(homePath, resolvedPath)) {
    throw new Error(`Path is outside the allowed directory: ${homePath}`);
  }
  return resolvedPath;
}

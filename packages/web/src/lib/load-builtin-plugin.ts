import "server-only";

/**
 * Resolve and import a built-in plugin package by name.
 *
 * Next.js webpack cannot resolve the core plugin registry's dynamic
 * `import(variable)` built-in loading path, so we resolve the package
 * entrypoint ourselves and import it by file URL.
 *
 * Extracted from `services.ts` so unit tests can mock the whole module
 * (mocking bare package names does not intercept `import()` of a
 * `file://…` URL).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export type BuiltinPlugin = { default?: unknown };

export async function loadBuiltinPluginModule(packageName: string): Promise<BuiltinPlugin> {
  const packageRoot = resolveBuiltinPackageRoot(packageName);
  const packageJson = JSON.parse(
    readFileSync(resolvePath(packageRoot, "package.json"), "utf8"),
  ) as {
    exports?: { ".": { import?: string } };
    main?: string;
  };
  const entry = packageJson.exports?.["."].import ?? packageJson.main;

  if (!entry) {
    throw new Error(`No import entry found in ${packageName}/package.json`);
  }

  const resolvedUrl = pathToFileURL(resolvePath(packageRoot, entry)).href;
  return import(/* webpackIgnore: true */ resolvedUrl) as Promise<BuiltinPlugin>;
}

function resolveBuiltinPackageRoot(packageName: string): string {
  const installedPackageRoot = resolvePath(process.cwd(), "node_modules", ...packageName.split("/"));
  if (existsSync(resolvePath(installedPackageRoot, "package.json"))) {
    return installedPackageRoot;
  }

  const workspacePluginName = packageName.replace("@aoagents/ao-plugin-", "");
  const monorepoRoot = findMonorepoRoot(process.cwd());
  const workspacePackageRoot = resolvePath(monorepoRoot, "packages", "plugins", workspacePluginName);
  if (existsSync(resolvePath(workspacePackageRoot, "package.json"))) {
    return workspacePackageRoot;
  }

  throw new Error(
    `Could not resolve ${packageName} from ${installedPackageRoot} or ${workspacePackageRoot}`,
  );
}

function findMonorepoRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (existsSync(resolvePath(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not find monorepo root from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getShell, isWindows } from "@composio/ao-core";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");

export function resolveRepoRoot(): string {
  const override = process.env["AO_REPO_ROOT"];
  return override ? resolve(override) : DEFAULT_REPO_ROOT;
}

export function resolveScriptPath(scriptName: string): string {
  const scriptPath = resolve(resolveRepoRoot(), "scripts", scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}`);
  }
  return scriptPath;
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  const shellOverride = process.env["AO_BASH_PATH"];
  const shell = shellOverride || getShell().cmd;
  const scriptPath = resolveScriptPath(scriptName);
  // Unix: spawn(shell, [scriptPath, ...args]) uses file mode — args reach $1, $2, etc.
  // Windows (no override): use getShell().args() to include required flags (e.g. -Command for pwsh).
  // With AO_BASH_PATH override: always use file mode (the override IS a bash-compatible binary).
  const shellArgs =
    shellOverride || !isWindows()
      ? [scriptPath, ...args]
      : [...getShell().args(scriptPath), ...args];

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd: resolveRepoRoot(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }

      resolveExit(code ?? 1);
    });
  });
}

export async function executeScriptCommand(scriptName: string, args: string[]): Promise<void> {
  try {
    const exitCode = await runRepoScript(scriptName, args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

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
  // Unix: always use bash — repo scripts have #!/bin/bash shebangs and bash-specific syntax.
  // Shebangs are only honoured by the kernel when a file is executed directly; when passed as
  // an argument to another interpreter (e.g. zsh script.sh) the shebang is ignored, so we must
  // name bash explicitly rather than using the user's $SHELL.
  // Windows: use getShell() (resolves to pwsh > powershell.exe > cmd.exe).
  const shell = shellOverride || (isWindows() ? getShell().cmd : "bash");
  const scriptPath = resolveScriptPath(scriptName);
  // Unix: spawn(bash, [scriptPath, ...args]) — file mode so args reach $1, $2, etc.
  // Windows (no override): use -File so positional args ($1, $2, …) reach the script.
  //   -Command folds everything into a single string; extra argv elements after the script
  //   path are treated as top-level PowerShell args, not script args — silently dropping
  //   flags like --fix. -File is the correct PowerShell flag for running a script with args.
  // With AO_BASH_PATH override: always use file mode (the override IS a bash-compatible binary).
  const shellArgs =
    shellOverride || !isWindows()
      ? [scriptPath, ...args]
      : ["-File", scriptPath, ...args];

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

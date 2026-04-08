import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "@composio/ao-core";

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
  // Windows: no native shell (pwsh, powershell.exe, cmd.exe) can run bash scripts —
  // shebangs are ignored and bash-specific syntax fails. AO_BASH_PATH is required.
  if (!shellOverride && isWindows()) {
    throw new Error(
      "Cannot run repo scripts on Windows without bash. " +
        "Set AO_BASH_PATH to a bash executable " +
        "(e.g. C:\\Program Files\\Git\\bin\\bash.exe).",
    );
  }

  const shell = shellOverride ?? "bash";
  const scriptPath = resolveScriptPath(scriptName);

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, [scriptPath, ...args], {
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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "@aoagents/ao-core";

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

// Common Git Bash install locations on Windows. WSL's bash.exe is intentionally
// excluded: when invoked from Windows-native Node, the spawned WSL bash sees
// Linux paths (/mnt/c/...) while cwd is a Windows path (D:\...), which silently
// breaks repo scripts. Users on WSL run `ao` as a Linux process anyway, where
// process.platform === "linux" and this branch never executes.
const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

function detectWindowsBash(): string | null {
  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  let shellOverride = process.env["AO_BASH_PATH"];
  // Unix: always use bash — repo scripts have #!/bin/bash shebangs and bash-specific syntax.
  // Shebangs are only honoured by the kernel when a file is executed directly; when passed as
  // an argument to another interpreter (e.g. zsh script.sh) the shebang is ignored, so we must
  // name bash explicitly rather than using the user's $SHELL.
  // Windows: no native shell (pwsh, powershell.exe, cmd.exe) can run bash scripts —
  // shebangs are ignored and bash-specific syntax fails. Auto-detect Git Bash / WSL,
  // fall back to AO_BASH_PATH, throw with guidance if neither is found.
  if (!shellOverride && isWindows()) {
    const detected = detectWindowsBash();
    if (!detected) {
      throw new Error(
        "Cannot run repo scripts on Windows without bash. " +
          "Install Git for Windows (https://git-scm.com/download/win) or " +
          "set AO_BASH_PATH to a bash executable " +
          "(e.g. C:\\Program Files\\Git\\bin\\bash.exe).",
      );
    }
    shellOverride = detected;
  }

  const shell = shellOverride ?? "bash";
  const scriptPath = resolveScriptPath(scriptName);

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, [scriptPath, ...args], {
      cwd: resolveRepoRoot(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
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

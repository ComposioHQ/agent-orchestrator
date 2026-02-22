import { getShellProfile } from "./shell-profiles.js";
import type { ShellCommandSpec, SpawnSpec } from "./types.js";

function normalizeWindowsPathForWsl(path: string): string {
  // C:\repo\project -> /mnt/c/repo/project
  const m = path.match(/^([a-zA-Z]):\\(.*)$/);
  if (!m) return path.replace(/\\/g, "/");
  const drive = m[1].toLowerCase();
  const tail = m[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${tail}`;
}

function ensureNonEmptyCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    throw new Error("Command cannot be empty");
  }
  return trimmed;
}

export function buildSpawnSpec(spec: ShellCommandSpec): SpawnSpec {
  const profile = getShellProfile(spec.profile);
  const command = ensureNonEmptyCommand(spec.command);

  switch (spec.profile) {
    case "windows-powershell":
      return {
        executable: profile.executable,
        args: [...profile.startupArgs, command],
        cwd: spec.cwd,
      };
    case "cmd":
      return {
        executable: profile.executable,
        args: [...profile.startupArgs, command],
        cwd: spec.cwd,
      };
    case "git-bash":
      return {
        executable: profile.executable,
        args: [...profile.startupArgs, command],
        cwd: spec.cwd,
      };
    case "wsl": {
      const distro = spec.wslDistribution?.trim();
      const args: string[] = [];
      if (distro) args.push("--distribution", distro);
      if (spec.cwd) args.push("--cd", normalizeWindowsPathForWsl(spec.cwd));
      args.push("--exec", "bash", "-lc", command);
      return {
        executable: profile.executable,
        args,
      };
    }
    default: {
      const unreachable: never = spec.profile;
      throw new Error(`Unsupported shell profile: ${String(unreachable)}`);
    }
  }
}

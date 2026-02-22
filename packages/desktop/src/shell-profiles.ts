import type { ShellProfile, ShellProfileId } from "./types.js";

const WINDOWS_POWERSHELL: ShellProfile = {
  id: "windows-powershell",
  label: "Windows PowerShell",
  executable: "powershell.exe",
  startupArgs: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
  requiresWindowsHost: true,
};

const CMD: ShellProfile = {
  id: "cmd",
  label: "Command Prompt",
  executable: "cmd.exe",
  startupArgs: ["/d", "/s", "/c"],
  requiresWindowsHost: true,
};

const GIT_BASH: ShellProfile = {
  id: "git-bash",
  label: "Git Bash",
  executable: "bash.exe",
  startupArgs: ["-lc"],
};

const WSL: ShellProfile = {
  id: "wsl",
  label: "Windows Subsystem for Linux",
  executable: "wsl.exe",
  startupArgs: [],
  requiresWindowsHost: true,
};

export const SHELL_PROFILES: Record<ShellProfileId, ShellProfile> = {
  "windows-powershell": WINDOWS_POWERSHELL,
  cmd: CMD,
  "git-bash": GIT_BASH,
  wsl: WSL,
};

export const DEFAULT_WINDOWS_FALLBACK_ORDER: ShellProfileId[] = [
  "windows-powershell",
  "cmd",
  "wsl",
  "git-bash",
];

export function getShellProfile(id: ShellProfileId): ShellProfile {
  return SHELL_PROFILES[id];
}

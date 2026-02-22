export type ShellProfileId = "windows-powershell" | "cmd" | "git-bash" | "wsl";

export interface ShellProfile {
  id: ShellProfileId;
  label: string;
  executable: string;
  startupArgs: string[];
  requiresWindowsHost?: boolean;
}

export interface ShellCapability {
  profile: ShellProfile;
  available: boolean;
  resolvedPath: string | null;
  reason?: string;
}

export interface ShellSelection {
  preferred?: ShellProfileId;
  fallbackOrder?: ShellProfileId[];
  wslDistribution?: string;
  gitBashPath?: string;
}

export interface ShellCommandSpec {
  profile: ShellProfileId;
  command: string;
  cwd?: string;
  wslDistribution?: string;
}

export interface SpawnSpec {
  executable: string;
  args: string[];
  cwd?: string;
}

export interface SidecarStartOptions {
  scriptPath: string;
  cwd?: string;
  env?: Record<string, string>;
  args?: string[];
}

export interface SidecarStatus {
  running: boolean;
  pid: number | null;
  startedAt: Date | null;
  scriptPath: string | null;
}

import type { ShellProfileId } from "../types.js";

export type JobStatus = "running" | "exited" | "killed" | "failed";

export interface RunRequest {
  command: string;
  profile?: ShellProfileId;
  cwd?: string;
  wslDistribution?: string;
}

export interface SidecarJob {
  id: string;
  profile: ShellProfileId;
  command: string;
  cwd?: string;
  status: JobStatus;
  startedAt: Date;
  finishedAt?: Date;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
}

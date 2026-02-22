export {
  DEFAULT_WINDOWS_FALLBACK_ORDER,
  SHELL_PROFILES,
  getShellProfile,
} from "./shell-profiles.js";
export { probeShellCapabilities, selectShellProfile } from "./shell-capabilities.js";
export { buildSpawnSpec } from "./shell-adapter.js";
export { runShellCommand } from "./shell-runner.js";
export { SidecarManager } from "./sidecar-manager.js";
export { createDesktopSidecarServer } from "./sidecar/server.js";
export type { RunRequest, SidecarJob, JobStatus } from "./sidecar/types.js";
export type {
  ShellProfile,
  ShellProfileId,
  ShellCapability,
  ShellSelection,
  ShellCommandSpec,
  SpawnSpec,
  SidecarStartOptions,
  SidecarStatus,
} from "./types.js";

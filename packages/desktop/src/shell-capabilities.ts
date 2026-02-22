import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_WINDOWS_FALLBACK_ORDER, getShellProfile } from "./shell-profiles.js";
import type { ShellCapability, ShellProfileId, ShellSelection } from "./types.js";

const execFile = promisify(execFileCb);

function isWindowsHost(): boolean {
  return process.platform === "win32";
}

async function resolveBinaryPath(executable: string): Promise<string | null> {
  try {
    if (isWindowsHost()) {
      const { stdout } = await execFile("where.exe", [executable], { windowsHide: true });
      const line = stdout.split(/\r?\n/).find((v) => v.trim().length > 0);
      return line?.trim() ?? null;
    }

    const { stdout } = await execFile("which", [executable], { windowsHide: true });
    const line = stdout.split(/\r?\n/).find((v) => v.trim().length > 0);
    return line?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function probeShellCapabilities(
  selection?: ShellSelection,
): Promise<ShellCapability[]> {
  const order = selection?.fallbackOrder ?? DEFAULT_WINDOWS_FALLBACK_ORDER;
  const capabilities: ShellCapability[] = [];

  for (const id of order) {
    const profile = getShellProfile(id);
    if (profile.requiresWindowsHost && !isWindowsHost()) {
      capabilities.push({
        profile,
        available: false,
        resolvedPath: null,
        reason: "requires Windows host",
      });
      continue;
    }

    if (id === "git-bash" && selection?.gitBashPath) {
      capabilities.push({
        profile: { ...profile, executable: selection.gitBashPath },
        available: true,
        resolvedPath: selection.gitBashPath,
      });
      continue;
    }

    const resolved = await resolveBinaryPath(profile.executable);
    capabilities.push({
      profile,
      available: resolved !== null,
      resolvedPath: resolved,
      ...(resolved ? {} : { reason: "binary not found in PATH" }),
    });
  }

  return capabilities;
}

export async function selectShellProfile(
  selection?: ShellSelection,
): Promise<{ profileId: ShellProfileId; resolvedPath: string }> {
  const preferred = selection?.preferred;
  const capabilities = await probeShellCapabilities(selection);

  if (preferred) {
    const explicit = capabilities.find((v) => v.profile.id === preferred);
    if (explicit?.available && explicit.resolvedPath) {
      return { profileId: explicit.profile.id, resolvedPath: explicit.resolvedPath };
    }
    throw new Error(`Preferred shell profile "${preferred}" is not available`);
  }

  const first = capabilities.find((v) => v.available && v.resolvedPath);
  if (!first || !first.resolvedPath) {
    throw new Error("No supported shell profile is available on this machine");
  }

  return { profileId: first.profile.id, resolvedPath: first.resolvedPath };
}

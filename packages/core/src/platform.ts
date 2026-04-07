import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { homedir, userInfo } from "node:os";

const execFileAsync = promisify(execFileCb);

/**
 * Cross-platform adapter.
 *
 * All platform-branching logic lives here. Every other module imports
 * from this file instead of doing ad-hoc process.platform checks.
 */

export function isWindows(): boolean {
  return process.platform === "win32";
}

export function getDefaultRuntime(): "tmux" | "process" {
  return isWindows() ? "process" : "tmux";
}

// -- Shell resolution --

interface ShellInfo {
  cmd: string;
  args: (command: string) => string[];
}

let cachedShell: ShellInfo | null = null;

function resolveWindowsShell(): ShellInfo {
  // Prefer pwsh (PowerShell Core, cross-platform)
  try {
    execFileSync("pwsh", ["-Version"], { timeout: 5000, stdio: "ignore" });
    return { cmd: "pwsh", args: (c) => ["-Command", c] };
  } catch {
    // not installed
  }

  // Fall back to powershell.exe (Windows PowerShell, always on Win 10+)
  try {
    execFileSync("powershell.exe", ["-Command", "echo ok"], { timeout: 5000, stdio: "ignore" });
    return { cmd: "powershell.exe", args: (c) => ["-Command", c] };
  } catch {
    // not available (very unlikely on Win 10+)
  }

  // Last resort: cmd.exe
  const comspec = process.env["ComSpec"] || "cmd.exe";
  return { cmd: comspec, args: (c) => ["/c", c] };
}

export function getShell(): ShellInfo {
  if (cachedShell) return cachedShell;

  if (isWindows()) {
    cachedShell = resolveWindowsShell();
  } else {
    const shell = process.env["SHELL"] || "/bin/sh";
    cachedShell = { cmd: shell, args: (c) => ["-c", c] };
  }

  return cachedShell;
}

/** Reset cached shell (for testing) */
export function _resetShellCache(): void {
  cachedShell = null;
}

// -- Process tree kill --

export async function killProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  if (isWindows()) {
    // taskkill /T kills the process tree, /F forces termination
    try {
      await execFileAsync("taskkill", ["/T", "/F", "/PID", String(pid)]);
    } catch {
      // Process may already be dead
    }
  } else {
    // Unix: negative PID kills the process group
    try {
      process.kill(-pid, signal);
    } catch {
      // Process group may not exist, try direct kill
      try {
        process.kill(pid, signal);
      } catch {
        // Already dead
      }
    }
  }
}

// -- Port-based PID discovery --

export async function findPidByPort(port: number): Promise<string | null> {
  try {
    if (isWindows()) {
      // netstat -ano shows all connections with PIDs
      const { stdout } = await execFileAsync("netstat", ["-ano"]);
      for (const line of stdout.split("\n")) {
        // Match LISTENING state on the target port
        if (line.includes(`:${port}`) && line.includes("LISTENING")) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && /^\d+$/.test(pid)) return pid;
        }
      }
      return null;
    } else {
      // Unix: lsof
      const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
      const pid = stdout.trim().split("\n")[0]?.trim();
      if (!pid || !/^\d+$/.test(pid)) return null;
      return pid;
    }
  } catch {
    return null;
  }
}

// -- Environment defaults --

interface EnvDefaults {
  HOME: string;
  SHELL: string;
  TMPDIR: string;
  PATH: string;
  USER: string;
}

export function getEnvDefaults(): EnvDefaults {
  if (isWindows()) {
    return {
      HOME: process.env["USERPROFILE"] || homedir(),
      SHELL: getShell().cmd,
      TMPDIR: process.env["TEMP"] || process.env["TMP"] || "C:\\Windows\\Temp",
      PATH: process.env["PATH"] || "",
      USER: process.env["USERNAME"] || userInfo().username,
    };
  }

  return {
    HOME: process.env["HOME"] || homedir(),
    SHELL: process.env["SHELL"] || "/bin/bash",
    TMPDIR: process.env["TMPDIR"] || "/tmp",
    PATH: process.env["PATH"] || "/usr/local/bin:/usr/bin:/bin",
    USER: process.env["USER"] || userInfo().username,
  };
}

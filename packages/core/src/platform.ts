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
    execFileSync("pwsh", ["-Version"], { timeout: 5000, stdio: "ignore", windowsHide: true });
    return { cmd: "pwsh", args: (c) => ["-Command", c] };
  } catch {
    // not installed
  }

  // Fall back to powershell.exe (Windows PowerShell, always on Win 10+)
  try {
    execFileSync("powershell.exe", ["-Command", "echo ok"], {
      timeout: 5000,
      stdio: "ignore",
      windowsHide: true,
    });
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
    // Always use /bin/sh, not $SHELL. postCreate commands and runtime launches are
    // non-interactive; using $SHELL would break if the user's login shell is
    // non-POSIX (e.g. fish, nushell). /bin/sh is guaranteed POSIX-compliant on all Unix systems.
    cachedShell = { cmd: "/bin/sh", args: (c) => ["-c", c] };
  }

  return cachedShell;
}

/** Reset cached shell (for testing)
 * @internal
 */
export function _resetShellCache(): void {
  cachedShell = null;
}

// -- Process tree kill --

export async function killProcessTree(
  pid: number,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  // pid=0 means "current process group" on Unix (-0 === 0 in JS), which would
  // kill AO itself. pid<0 is never valid. Guard both.
  if (pid <= 0) return;
  if (isWindows()) {
    // Always use /F (force) on Windows. taskkill without /F sends WM_CLOSE, which
    // only works for GUI windows; headless Node.js console processes may ignore it,
    // leaving orphaned processes. Callers that do SIGTERM→wait→SIGKILL escalation
    // are unaffected: the SIGKILL step simply finds the process already dead.
    const args = ["/T", "/F", "/PID", String(pid)];
    try {
      await execFileAsync("taskkill", args, { windowsHide: true });
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
      const { stdout } = await execFileAsync("netstat", ["-ano"], { windowsHide: true });
      const portPattern = new RegExp(`:${port}(?!\\d)`);
      for (const line of stdout.split("\n")) {
        // Match LISTENING state on the target local port exactly
        const parts = line.trim().split(/\s+/);
        const localAddress = parts[1];
        if (line.includes("LISTENING") && localAddress && portPattern.test(localAddress)) {
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

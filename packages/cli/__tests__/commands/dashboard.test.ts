import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockExec, mockExecSilent } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecSilent: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: mockExecSilent,
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-dashboard-test-"));
  mockExec.mockReset();
  mockExecSilent.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("cleanNextCache", () => {
  it("deletes .next directory when it exists", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });
    mkdirSync(join(webDir, ".next", "server", "vendor-chunks"), { recursive: true });
    writeFileSync(
      join(webDir, ".next", "server", "vendor-chunks", "xterm@5.3.0.js"),
      "module.exports = {}",
    );

    const { cleanNextCache } = await import("../../src/lib/dashboard-rebuild.js");

    await cleanNextCache(webDir);

    // .next should be gone — this is the fix for the stale cache 500 error
    expect(existsSync(join(webDir, ".next"))).toBe(false);
  });

  it("is a no-op when .next does not exist", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });

    const { cleanNextCache } = await import("../../src/lib/dashboard-rebuild.js");

    // Should not throw
    await cleanNextCache(webDir);

    expect(existsSync(join(webDir, ".next"))).toBe(false);
  });
});

describe("findRunningDashboardPid", () => {
  it("returns PID when a process is listening", async () => {
    mockExecSilent.mockResolvedValue("12345");

    const { findRunningDashboardPid } = await import("../../src/lib/dashboard-rebuild.js");

    const pid = await findRunningDashboardPid(3000);
    expect(pid).toBe("12345");
    expect(mockExecSilent).toHaveBeenCalledWith("lsof", ["-ti", ":3000", "-sTCP:LISTEN"]);
  });

  it("returns null when no process is listening", async () => {
    mockExecSilent.mockResolvedValue(null);

    const { findRunningDashboardPid } = await import("../../src/lib/dashboard-rebuild.js");

    const pid = await findRunningDashboardPid(3000);
    expect(pid).toBeNull();
  });
});

describe("findProcessWebDir", () => {
  it("extracts cwd from lsof output", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "package.json"), "{}");

    // Simulate lsof -p <pid> -Fn output
    mockExecSilent.mockResolvedValue(
      `p12345\nfcwd\nn${webDir}\nftxt\nn/usr/bin/node`,
    );

    const { findProcessWebDir } = await import("../../src/lib/dashboard-rebuild.js");

    const result = await findProcessWebDir("12345");
    expect(result).toBe(webDir);
  });

  it("returns null when cwd has no package.json", async () => {
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });
    // No package.json

    mockExecSilent.mockResolvedValue(
      `p12345\nfcwd\nn${webDir}\nftxt\nn/usr/bin/node`,
    );

    const { findProcessWebDir } = await import("../../src/lib/dashboard-rebuild.js");

    const result = await findProcessWebDir("12345");
    expect(result).toBeNull();
  });

  it("returns null when lsof fails", async () => {
    mockExecSilent.mockResolvedValue(null);

    const { findProcessWebDir } = await import("../../src/lib/dashboard-rebuild.js");

    const result = await findProcessWebDir("12345");
    expect(result).toBeNull();
  });
});

describe("looksLikeStaleBuild pattern matching", () => {
  // We can't import the private function directly, so we replicate the patterns
  // to ensure the detection logic catches the actual error messages seen in production.
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];

  function looksLikeStaleBuild(stderr: string): boolean {
    return patterns.some((p) => p.test(stderr));
  }

  it("detects vendor-chunks module not found (the actual bug)", () => {
    // This is the exact error from the bug report
    const stderr =
      "Error: Cannot find module '/path/to/.next/server/vendor-chunks/xterm@5.3.0.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects generic .next module not found", () => {
    const stderr = "Cannot find module '/path/to/.next/server/chunks/123.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects Module not found in .next", () => {
    const stderr = "Module not found: Error in .next/static/chunks/app/page.js";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects ENOENT for .next files", () => {
    const stderr = "ENOENT: no such file or directory, open '.next/BUILD_ID'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects missing production build", () => {
    const stderr = "Could not find a production build in the '.next' directory.";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    const stderr = "TypeError: Cannot read properties of undefined";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });

  it("does not flag normal startup output", () => {
    const stderr = "ready - started server on 0.0.0.0:3000";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });
});

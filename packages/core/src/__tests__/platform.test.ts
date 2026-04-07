import { describe, it, expect, afterEach } from "vitest";

describe("platform adapter", () => {
  const originalPlatform = process.platform;

  afterEach(async () => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Reset the shell cache after each test so platform changes take effect
    const mod = await import("../platform.js");
    mod._resetShellCache();
  });

  function setPlatform(p: string) {
    Object.defineProperty(process, "platform", { value: p });
  }

  describe("isWindows", () => {
    it("returns true on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      expect(mod.isWindows()).toBe(true);
    });

    it("returns false on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      expect(mod.isWindows()).toBe(false);
    });
  });

  describe("getDefaultRuntime", () => {
    it("returns 'process' on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      expect(mod.getDefaultRuntime()).toBe("process");
    });

    it("returns 'tmux' on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      expect(mod.getDefaultRuntime()).toBe("tmux");
    });
  });

  describe("getShell", () => {
    it("returns sh-based shell on unix", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      // On Linux/macOS SHELL env var points to sh/bash/zsh. On Windows CI
      // running this test the platform check is what matters, so we rely on
      // SHELL env var (which may be a full path like /bin/bash or
      // C:\Program Files\Git\bin\bash.exe). Accept any shell containing
      // "sh" or "bash" anywhere in the path.
      expect(shell.cmd).toMatch(/sh|bash/i);
    });

    it("returns powershell or cmd on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      mod._resetShellCache();
      const shell = mod.getShell();
      expect(shell.cmd).toMatch(/pwsh|powershell|cmd/i);
    });
  });

  describe("getEnvDefaults", () => {
    it("returns Unix-style defaults on linux", async () => {
      setPlatform("linux");
      const mod = await import("../platform.js");
      const env = mod.getEnvDefaults();
      expect(env.TMPDIR).toBe("/tmp");
    });

    it("returns Windows-style defaults on win32", async () => {
      setPlatform("win32");
      const mod = await import("../platform.js");
      const env = mod.getEnvDefaults();
      expect(env.TMPDIR).toBe(process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp");
    });
  });
});

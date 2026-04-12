import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available before module import
// ---------------------------------------------------------------------------

const { mockExistsSync, mockReadFileSync, mockWriteFileSync, mockUnlinkSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockExistsSync: vi.fn<(path: string) => boolean>(),
    mockReadFileSync: vi.fn<(path: string, encoding: string) => string>(),
    mockWriteFileSync: vi.fn(),
    mockUnlinkSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(args[0] as string),
    readFileSync: (...args: unknown[]) => mockReadFileSync(args[0] as string, args[1] as string),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

const { mockGetCliVersion } = vi.hoisted(() => ({
  mockGetCliVersion: vi.fn(() => "0.2.2"),
}));

vi.mock("../../src/options/version.js", () => ({
  getCliVersion: () => mockGetCliVersion(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  detectInstallMethod,
  getCurrentVersion,
  getUpdateCommand,
  readCachedUpdateInfo,
  fetchLatestVersion,
  invalidateCache,
  checkForUpdate,
  maybeShowUpdateNotice,
  scheduleBackgroundRefresh,
  isVersionOutdated,
} from "../../src/lib/update-check.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("update-check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // isVersionOutdated
  // -----------------------------------------------------------------------

  describe("isVersionOutdated", () => {
    it("returns true when current major is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "1.0.0")).toBe(true);
    });

    it("returns true when current minor is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "0.3.0")).toBe(true);
    });

    it("returns true when current patch is less than latest", () => {
      expect(isVersionOutdated("0.2.2", "0.2.3")).toBe(true);
    });

    it("returns false when versions are equal", () => {
      expect(isVersionOutdated("0.2.2", "0.2.2")).toBe(false);
    });

    it("returns false when current is newer than latest", () => {
      expect(isVersionOutdated("1.0.0", "0.9.9")).toBe(false);
    });

    it("returns false when current minor is greater", () => {
      expect(isVersionOutdated("0.3.0", "0.2.9")).toBe(false);
    });

    it("handles versions with missing patch", () => {
      expect(isVersionOutdated("1.0", "1.0.1")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // detectInstallMethod
  // -----------------------------------------------------------------------

  describe("detectInstallMethod", () => {
    it("returns 'git' when repo root has scripts/ao-update.sh and .git", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith("scripts/ao-update.sh")) return true;
        if (path.endsWith(".git")) return true;
        return false;
      });

      expect(detectInstallMethod()).toBe("git");
    });

    it("returns 'unknown' when .git exists but scripts/ao-update.sh does not", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith(".git")) return true;
        return false;
      });

      expect(detectInstallMethod()).toBe("unknown");
    });

    it("returns 'unknown' when scripts/ao-update.sh exists but .git does not", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith("scripts/ao-update.sh")) return true;
        return false;
      });

      expect(detectInstallMethod()).toBe("unknown");
    });

    it("returns 'unknown' when neither .git nor scripts/ao-update.sh exist", () => {
      mockExistsSync.mockReturnValue(false);
      expect(detectInstallMethod()).toBe("unknown");
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentVersion
  // -----------------------------------------------------------------------

  describe("getCurrentVersion", () => {
    it("returns a valid semver version string", () => {
      const version = getCurrentVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  // -----------------------------------------------------------------------
  // getUpdateCommand
  // -----------------------------------------------------------------------

  describe("getUpdateCommand", () => {
    it("returns 'ao update' for git installs", () => {
      expect(getUpdateCommand("git")).toBe("ao update");
    });

    it("returns npm install command for npm-global installs", () => {
      expect(getUpdateCommand("npm-global")).toBe("npm install -g @aoagents/ao@latest");
    });

    it("returns npm install command for unknown installs", () => {
      expect(getUpdateCommand("unknown")).toBe("npm install -g @aoagents/ao@latest");
    });
  });

  // -----------------------------------------------------------------------
  // readCachedUpdateInfo
  // -----------------------------------------------------------------------

  describe("readCachedUpdateInfo", () => {
    it("returns null when no cache file exists", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns cached data when fresh and version matches", () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
        }),
      );

      const result = readCachedUpdateInfo();
      expect(result).not.toBeNull();
      expect(result!.latestVersion).toBe("0.3.0");
      expect(result!.checkedAt).toBe(now);
      expect(result!.currentVersionAtCheck).toBe(currentVersion);
    });

    it("returns null when cache is expired (>24h)", () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: old,
          currentVersionAtCheck: currentVersion,
        }),
      );

      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns cached data when cache is just under 24h old", () => {
      const recent = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: recent,
          currentVersionAtCheck: currentVersion,
        }),
      );

      expect(readCachedUpdateInfo()).not.toBeNull();
    });

    it("returns null when currentVersionAtCheck differs from installed version", () => {
      const now = new Date().toISOString();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.5.0",
          checkedAt: now,
          currentVersionAtCheck: "9.9.9",
        }),
      );

      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null on invalid JSON", () => {
      mockReadFileSync.mockReturnValue("not json{{{");
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when latestVersion field is missing", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ checkedAt: new Date().toISOString() }),
      );
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when checkedAt field is missing", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ latestVersion: "1.0.0" }),
      );
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null on empty string cache file", () => {
      mockReadFileSync.mockReturnValue("");
      expect(readCachedUpdateInfo()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // fetchLatestVersion
  // -----------------------------------------------------------------------

  describe("fetchLatestVersion", () => {
    it("returns version string from registry", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const version = await fetchLatestVersion();
      expect(version).toBe("0.3.0");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://registry.npmjs.org/@aoagents%2Fao/latest",
        expect.objectContaining({ headers: { Accept: "application/json" } }),
      );
    });

    it("passes an AbortSignal for timeout", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "1.0.0" }),
      });

      await fetchLatestVersion();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]).toHaveProperty("signal");
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on 500 server error", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"));
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on timeout (AbortError)", async () => {
      const abortError = new DOMException("signal timed out", "TimeoutError");
      mockFetch.mockRejectedValue(abortError);
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on non-JSON response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null when version field is missing", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: "@aoagents/ao" }),
      });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null when version field is not a string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: 123 }),
      });
      expect(await fetchLatestVersion()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // invalidateCache
  // -----------------------------------------------------------------------

  describe("invalidateCache", () => {
    it("calls unlinkSync on cache path", () => {
      mockUnlinkSync.mockImplementation(() => {});
      invalidateCache();
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
      expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining("update-check.json"));
    });

    it("does not throw when cache file does not exist", () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(() => invalidateCache()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // checkForUpdate
  // -----------------------------------------------------------------------

  describe("checkForUpdate", () => {
    it("uses cache when fresh and does not call fetch", async () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
        }),
      );
      mockExistsSync.mockReturnValue(false);

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(true);
      expect(info.latestVersion).toBe("0.3.0");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("bypasses cache when force: true", async () => {
      const now = new Date().toISOString();
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: currentVersion,
        }),
      );
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.4.0" }),
      });

      const info = await checkForUpdate({ force: true });
      expect(mockFetch).toHaveBeenCalled();
      expect(info.latestVersion).toBe("0.4.0");
    });

    it("fetches from registry when cache is stale", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(true);
      expect(info.latestVersion).toBe("0.3.0");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("writes cache after successful fetch", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      await checkForUpdate();

      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
      const writtenData = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(writtenData.latestVersion).toBe("0.3.0");
      expect(writtenData.currentVersionAtCheck).toBe(getCurrentVersion());
      expect(writtenData.checkedAt).toBeDefined();
    });

    it("does NOT write cache when fetch fails", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network error"));

      await checkForUpdate();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("returns isOutdated=false when registry version matches installed", async () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: currentVersion }),
      });

      const info = await checkForUpdate({ force: true });
      expect(info.isOutdated).toBe(false);
    });

    it("returns isOutdated=false when registry is unreachable", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network error"));

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(false);
      expect(info.latestVersion).toBeNull();
      expect(info.checkedAt).toBeNull();
    });

    it("includes installMethod and recommendedCommand in result", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      const info = await checkForUpdate();
      expect(info.installMethod).toBeDefined();
      expect(info.recommendedCommand).toBeDefined();
      expect(typeof info.recommendedCommand).toBe("string");
    });
  });

  // -----------------------------------------------------------------------
  // maybeShowUpdateNotice
  // -----------------------------------------------------------------------

  describe("maybeShowUpdateNotice", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let origIsTTY: boolean | undefined;
    let origCI: string | undefined;
    let origAOCI: string | undefined;
    let origNotifier: string | undefined;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      origIsTTY = process.stderr.isTTY;
      origCI = process.env["CI"];
      origAOCI = process.env["AGENT_ORCHESTRATOR_CI"];
      origNotifier = process.env["AO_NO_UPDATE_NOTIFIER"];
      // Default: enable TTY, disable CI/notifier env vars
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      delete process.env["CI"];
      delete process.env["AGENT_ORCHESTRATOR_CI"];
      delete process.env["AO_NO_UPDATE_NOTIFIER"];
    });

    afterEach(() => {
      Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
      if (origCI !== undefined) process.env["CI"] = origCI;
      else delete process.env["CI"];
      if (origAOCI !== undefined) process.env["AGENT_ORCHESTRATOR_CI"] = origAOCI;
      else delete process.env["AGENT_ORCHESTRATOR_CI"];
      if (origNotifier !== undefined) process.env["AO_NO_UPDATE_NOTIFIER"] = origNotifier;
      else delete process.env["AO_NO_UPDATE_NOTIFIER"];
    });

    it("prints update notice when cache shows outdated version", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "99.0.0",
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
        }),
      );

      maybeShowUpdateNotice();

      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const output = stderrSpy.mock.calls[0]![0] as string;
      expect(output).toContain("Update available");
      expect(output).toContain("99.0.0");
      expect(output).toContain("ao update");
    });

    it("does not print when versions match (not outdated)", () => {
      const currentVersion = getCurrentVersion();
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: currentVersion,
          checkedAt: new Date().toISOString(),
          currentVersionAtCheck: currentVersion,
        }),
      );

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when no cache exists", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when stderr is not a TTY", () => {
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when AO_NO_UPDATE_NOTIFIER=1", () => {
      process.env["AO_NO_UPDATE_NOTIFIER"] = "1";

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when CI=true", () => {
      process.env["CI"] = "true";

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("does not print when AGENT_ORCHESTRATOR_CI is set", () => {
      process.env["AGENT_ORCHESTRATOR_CI"] = "1";

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it.each(["update", "doctor", "--version", "-V", "--help", "-h"])(
      "does not print when argv includes '%s'",
      (arg) => {
        const origArgv = process.argv;
        process.argv = ["node", "ao", arg];

        maybeShowUpdateNotice();
        expect(stderrSpy).not.toHaveBeenCalled();

        process.argv = origArgv;
      },
    );
  });

  // -----------------------------------------------------------------------
  // scheduleBackgroundRefresh
  // -----------------------------------------------------------------------

  describe("scheduleBackgroundRefresh", () => {
    it("schedules a background fetch that does not block process exit", () => {
      // Mock fetch to track that it gets called
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ version: "0.3.0" }),
      });

      // Should not throw
      expect(() => scheduleBackgroundRefresh()).not.toThrow();
    });
  });
});

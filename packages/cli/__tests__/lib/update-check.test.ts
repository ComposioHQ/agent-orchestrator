import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
} from "../../src/lib/update-check.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("update-check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: existsSync returns false
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

      // In the test environment we're running from the repo source, so
      // import.meta.url won't contain node_modules. The existence checks
      // determine git vs unknown.
      expect(detectInstallMethod()).toBe("git");
    });

    it("returns 'unknown' when .git exists but scripts/ao-update.sh does not", () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path.endsWith(".git")) return true;
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
      // In monorepo, createRequire finds @aoagents/ao/package.json directly.
      // In npm-global, it would also find it. Fallback to getCliVersion is for
      // edge cases where the wrapper package is not resolvable.
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
      mockGetCliVersion.mockReturnValue("0.2.2");
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: "0.2.2",
        }),
      );

      const result = readCachedUpdateInfo();
      expect(result).not.toBeNull();
      expect(result!.latestVersion).toBe("0.3.0");
    });

    it("returns null when cache is expired (>24h)", () => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      mockGetCliVersion.mockReturnValue("0.2.2");
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: old,
          currentVersionAtCheck: "0.2.2",
        }),
      );

      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when currentVersionAtCheck differs from installed version", () => {
      const now = new Date().toISOString();
      // Cache was written when a different version was installed
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.5.0",
          checkedAt: now,
          currentVersionAtCheck: "9.9.9", // Does not match any real installed version
        }),
      );

      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null on invalid JSON", () => {
      mockReadFileSync.mockReturnValue("not json{{{");
      expect(readCachedUpdateInfo()).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ checkedAt: new Date().toISOString() }));
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

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404 });
      expect(await fetchLatestVersion()).toBeNull();
    });

    it("returns null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("fetch failed"));
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
  });

  // -----------------------------------------------------------------------
  // invalidateCache
  // -----------------------------------------------------------------------

  describe("invalidateCache", () => {
    it("calls unlinkSync on cache path", () => {
      mockUnlinkSync.mockImplementation(() => {});
      invalidateCache();
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1);
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
    it("uses cache when fresh", async () => {
      const now = new Date().toISOString();
      mockGetCliVersion.mockReturnValue("0.2.2");
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "0.3.0",
          checkedAt: now,
          currentVersionAtCheck: "0.2.2",
        }),
      );
      // existsSync for git detection
      mockExistsSync.mockReturnValue(false);

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(true);
      expect(info.latestVersion).toBe("0.3.0");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches from registry when cache is stale", async () => {
      mockGetCliVersion.mockReturnValue("0.2.2");
      // No cache
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
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("returns isOutdated=false when registry version matches installed", async () => {
      // Fetch returns the same version that's currently installed
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
      expect(info.currentVersion).toBe(currentVersion);
      expect(info.latestVersion).toBe(currentVersion);
    });

    it("returns isOutdated=false when registry is unreachable", async () => {
      mockGetCliVersion.mockReturnValue("0.2.2");
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      mockExistsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("network error"));

      const info = await checkForUpdate();
      expect(info.isOutdated).toBe(false);
      expect(info.latestVersion).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // maybeShowUpdateNotice
  // -----------------------------------------------------------------------

  describe("maybeShowUpdateNotice", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });

    it("does not print when stderr is not a TTY", () => {
      const origIsTTY = process.stderr.isTTY;
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();

      Object.defineProperty(process.stderr, "isTTY", { value: origIsTTY, configurable: true });
    });

    it("does not print when AO_NO_UPDATE_NOTIFIER=1", () => {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.env["AO_NO_UPDATE_NOTIFIER"] = "1";

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();

      delete process.env["AO_NO_UPDATE_NOTIFIER"];
    });

    it("does not print when CI=true", () => {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      const origCI = process.env["CI"];
      process.env["CI"] = "true";

      maybeShowUpdateNotice();
      expect(stderrSpy).not.toHaveBeenCalled();

      if (origCI !== undefined) process.env["CI"] = origCI;
      else delete process.env["CI"];
    });
  });
});

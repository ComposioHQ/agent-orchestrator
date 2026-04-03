import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    realpath: vi.fn((p: string) => Promise.resolve(p)),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: { ...actual, homedir: vi.fn(() => "/home/testuser") },
    homedir: vi.fn(() => "/home/testuser"),
  };
});

import { isWithinDirectory, getHomePath, resolveHomeScopedPath, assertPathWithinHome } from "../path-security";

beforeEach(() => {
  vi.mocked(realpath).mockImplementation((p) => Promise.resolve(p as string));
  vi.mocked(homedir).mockReturnValue("/home/testuser");
});

describe("isWithinDirectory", () => {
  it("returns true when child is same as parent", () => {
    expect(isWithinDirectory("/home/user", "/home/user")).toBe(true);
  });

  it("returns true when child is inside parent", () => {
    expect(isWithinDirectory("/home/user", "/home/user/projects/app")).toBe(true);
  });

  it("returns false when child is outside parent", () => {
    expect(isWithinDirectory("/home/user", "/etc/passwd")).toBe(false);
  });

  it("returns false for path traversal", () => {
    expect(isWithinDirectory("/home/user", "/home/user/../other")).toBe(false);
  });
});

describe("getHomePath", () => {
  it("returns the resolved home directory", async () => {
    const result = await getHomePath();
    expect(result).toBe("/home/testuser");
  });

  it("falls back to resolve when realpath fails", async () => {
    vi.mocked(realpath).mockRejectedValueOnce(new Error("ENOENT"));
    const result = await getHomePath();
    expect(typeof result).toBe("string");
  });
});

describe("resolveHomeScopedPath", () => {
  it("returns home path when no rawPath is provided", async () => {
    const result = await resolveHomeScopedPath();
    expect(result.homePath).toBe("/home/testuser");
    expect(result.resolvedPath).toBe("/home/testuser");
  });

  it("returns home path when null is provided", async () => {
    const result = await resolveHomeScopedPath(null);
    expect(result.homePath).toBe("/home/testuser");
  });

  it("resolves absolute path as-is", async () => {
    const result = await resolveHomeScopedPath("/absolute/path");
    expect(result.resolvedPath).toBe("/absolute/path");
  });

  it("joins relative path with home directory", async () => {
    const result = await resolveHomeScopedPath("relative/path");
    expect(result.resolvedPath).toBe("/home/testuser/relative/path");
  });
});

describe("assertPathWithinHome", () => {
  it("returns resolved path when within home", async () => {
    const result = await assertPathWithinHome("/home/testuser/projects");
    expect(result).toBe("/home/testuser/projects");
  });

  it("throws when path is outside home", async () => {
    await expect(assertPathWithinHome("/etc/passwd")).rejects.toThrow();
  });
});

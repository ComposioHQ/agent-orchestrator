import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAuthToken, readAuthToken, getAuthTokenPath } from "../auth.js";

const TEST_DIR = join(tmpdir(), `ao-auth-test-${process.pid}`);

beforeEach(() => {
  // Clean test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  // Clear env var
  delete process.env["AO_AUTH_TOKEN"];
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  delete process.env["AO_AUTH_TOKEN"];
});

describe("getAuthTokenPath", () => {
  it("returns path under given data dir", () => {
    const path = getAuthTokenPath("/tmp/test");
    expect(path).toBe("/tmp/test/.ao-auth-token");
  });
});

describe("readAuthToken", () => {
  it("returns null when no token configured", () => {
    const token = readAuthToken(TEST_DIR);
    expect(token).toBeNull();
  });

  it("returns env var token when set", () => {
    process.env["AO_AUTH_TOKEN"] = "test-token-from-env";
    const token = readAuthToken(TEST_DIR);
    expect(token).toBe("test-token-from-env");
  });

  it("returns file token when file exists", () => {
    writeFileSync(join(TEST_DIR, ".ao-auth-token"), "test-token-from-file\n");
    const token = readAuthToken(TEST_DIR);
    expect(token).toBe("test-token-from-file");
  });

  it("prefers env var over file", () => {
    process.env["AO_AUTH_TOKEN"] = "env-token";
    writeFileSync(join(TEST_DIR, ".ao-auth-token"), "file-token\n");
    const token = readAuthToken(TEST_DIR);
    expect(token).toBe("env-token");
  });

  it("returns null for empty file", () => {
    writeFileSync(join(TEST_DIR, ".ao-auth-token"), "");
    const token = readAuthToken(TEST_DIR);
    expect(token).toBeNull();
  });

  it("trims whitespace from env var", () => {
    process.env["AO_AUTH_TOKEN"] = "  spaced-token  ";
    const token = readAuthToken(TEST_DIR);
    expect(token).toBe("spaced-token");
  });
});

describe("ensureAuthToken", () => {
  it("generates a new token when none exists", () => {
    const token = ensureAuthToken(TEST_DIR);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Token file should be created
    const filePath = join(TEST_DIR, ".ao-auth-token");
    expect(existsSync(filePath)).toBe(true);

    // File content should match
    const fileContent = readFileSync(filePath, "utf-8").trim();
    expect(fileContent).toBe(token);
  });

  it("reuses existing token", () => {
    writeFileSync(join(TEST_DIR, ".ao-auth-token"), "existing-token\n");
    const token = ensureAuthToken(TEST_DIR);
    expect(token).toBe("existing-token");
  });

  it("returns env var token without writing file", () => {
    process.env["AO_AUTH_TOKEN"] = "env-override";
    const token = ensureAuthToken(TEST_DIR);
    expect(token).toBe("env-override");

    // Should not create file
    const filePath = join(TEST_DIR, ".ao-auth-token");
    expect(existsSync(filePath)).toBe(false);
  });

  it("creates data directory if missing", () => {
    const nestedDir = join(TEST_DIR, "nested", "deep");
    const token = ensureAuthToken(nestedDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(nestedDir)).toBe(true);
  });

  it("generates different tokens on separate calls to fresh dirs", () => {
    const dir1 = join(TEST_DIR, "dir1");
    const dir2 = join(TEST_DIR, "dir2");
    const token1 = ensureAuthToken(dir1);
    const token2 = ensureAuthToken(dir2);
    expect(token1).not.toBe(token2);
  });
});

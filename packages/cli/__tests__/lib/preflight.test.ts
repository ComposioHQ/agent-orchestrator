import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, mockIsPortAvailable, mockExistsSync, mockRequireResolve, mockCreateRequire } = vi.hoisted(() => {
  const mockRequireResolve = vi.fn();
  const mockCreateRequire = vi.fn(() => ({ resolve: mockRequireResolve }));
  return {
    mockExec: vi.fn(),
    mockIsPortAvailable: vi.fn(),
    mockExistsSync: vi.fn(),
    mockRequireResolve,
    mockCreateRequire,
  };
});

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  isPortAvailable: mockIsPortAvailable,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

vi.mock("node:module", () => ({
  createRequire: mockCreateRequire,
}));

import { preflight } from "../../src/lib/preflight.js";

beforeEach(() => {
  mockExec.mockReset();
  mockIsPortAvailable.mockReset();
  mockExistsSync.mockReset();
  mockRequireResolve.mockReset();
  mockCreateRequire.mockReset();
  mockCreateRequire.mockReturnValue({ resolve: mockRequireResolve });
});

describe("preflight.checkPort", () => {
  it("passes when port is free", async () => {
    mockIsPortAvailable.mockResolvedValue(true);
    await expect(preflight.checkPort(3000)).resolves.toBeUndefined();
    expect(mockIsPortAvailable).toHaveBeenCalledWith(3000);
  });

  it("throws when port is in use", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(3000)).rejects.toThrow(
      "Port 3000 is already in use",
    );
  });

  it("includes port number in error message", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(8080)).rejects.toThrow("Port 8080");
  });
});

describe("preflight.checkBuilt", () => {
  it("passes when ao-core resolves and dist exists", async () => {
    mockRequireResolve.mockReturnValue("/some/path/@composio/ao-core/package.json");
    mockExistsSync.mockReturnValue(true);
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
    expect(mockRequireResolve).toHaveBeenCalledWith("@composio/ao-core/package.json");
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it("throws 'pnpm install' when ao-core cannot be resolved (not installed)", async () => {
    mockRequireResolve.mockImplementation(() => { throw new Error("Cannot find module"); });
    await expect(preflight.checkBuilt("/web")).rejects.toThrow("pnpm install");
  });

  it("throws 'pnpm build' when ao-core resolves but dist/index.js is missing", async () => {
    mockRequireResolve.mockReturnValue("/some/path/@composio/ao-core/package.json");
    mockExistsSync.mockReturnValue(false);
    await expect(preflight.checkBuilt("/web")).rejects.toThrow(
      "Packages not built. Run: pnpm build",
    );
  });

  it("resolves ao-core via hoisted path (npm global install)", async () => {
    // Simulate hoisted path: ao-core is not under webDir/node_modules but resolves via createRequire
    mockRequireResolve.mockReturnValue("/global/node_modules/@composio/ao-core/package.json");
    mockExistsSync.mockReturnValue(true);
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
  });
});

describe("preflight.checkTmux", () => {
  it("passes when tmux is installed", async () => {
    mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });
    await expect(preflight.checkTmux()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
  });

  it("throws when tmux is not installed", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkTmux()).rejects.toThrow(
      "tmux is not installed",
    );
  });

  it("includes install instruction in error", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkTmux()).rejects.toThrow("brew install tmux");
  });
});

describe("preflight.checkGhAuth", () => {
  it("passes when gh is installed and authenticated", async () => {
    mockExec.mockResolvedValue({ stdout: "ok", stderr: "" });
    await expect(preflight.checkGhAuth()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
    expect(mockExec).toHaveBeenCalledWith("gh", ["auth", "status"]);
  });

  it("throws 'not installed' when gh is missing (ENOENT)", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI (gh) is not installed",
    );
    // Should only call --version, not auth status
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
  });

  it("throws 'not authenticated' when gh exists but auth fails", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" }) // --version succeeds
      .mockRejectedValueOnce(new Error("not logged in")); // auth status fails
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "GitHub CLI is not authenticated",
    );
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("includes correct fix instructions for each failure", async () => {
    // Not installed → install link
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow(
      "https://cli.github.com/",
    );

    mockExec.mockReset();

    // Not authenticated → auth login
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" })
      .mockRejectedValueOnce(new Error("not logged in"));
    await expect(preflight.checkGhAuth()).rejects.toThrow("gh auth login");
  });
});

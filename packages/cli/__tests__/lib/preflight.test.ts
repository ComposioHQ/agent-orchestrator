import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec, mockIsPortAvailable, mockExistsSync } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockIsPortAvailable: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  isPortAvailable: mockIsPortAvailable,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
}));

import { preflight } from "../../src/lib/preflight.js";

beforeEach(() => {
  mockExec.mockReset();
  mockIsPortAvailable.mockReset();
  mockExistsSync.mockReset();
});

describe("preflight.checkPort", () => {
  it("passes when port is free", async () => {
    mockIsPortAvailable.mockResolvedValue(true);
    await expect(preflight.checkPort(3000)).resolves.toBeUndefined();
    expect(mockIsPortAvailable).toHaveBeenCalledWith(3000);
  });

  it("throws when port is in use", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(3000)).rejects.toThrow("Port 3000 is already in use");
  });

  it("includes port number in error message", async () => {
    mockIsPortAvailable.mockResolvedValue(false);
    await expect(preflight.checkPort(8080)).rejects.toThrow("Port 8080");
  });
});

describe("preflight.checkBuilt", () => {
  it("passes when ao-core dir and dist/index.js both exist (pnpm layout)", async () => {
    // findPackageUp finds /web/node_modules/@composio/ao-core
    // then existsSync confirms dist/index.js inside it
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("/web/node_modules/@composio/ao-core")) return true;
      if (p.endsWith("/dist/index.js")) return true;
      return false;
    });
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
  });

  it("finds ao-core when hoisted to parent node_modules (npm global install)", async () => {
    // /usr/local/lib/node_modules/@composio/ao-web/node_modules/@composio/ao-core — miss
    // /usr/local/lib/node_modules/@composio/node_modules/@composio/ao-core — miss
    // /usr/local/lib/node_modules/node_modules/@composio/ao-core — miss
    // /usr/local/lib/node_modules/@composio/ao-core — hit (hoisted)
    mockExistsSync.mockImplementation((p: string) => {
      if (p === "/usr/local/lib/node_modules/@composio/ao-core") return true;
      if (p === "/usr/local/lib/node_modules/@composio/ao-core/dist/index.js") return true;
      return false;
    });
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@composio/ao-web"),
    ).resolves.toBeUndefined();
  });

  it("throws npm hint when ao-core not found in global install", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@composio/ao-web"),
    ).rejects.toThrow("npm install -g @composio/ao@latest");
  });

  it("throws pnpm hint when ao-core not found in monorepo", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/home/user/agent-orchestrator/packages/web"),
    ).rejects.toThrow("pnpm install && pnpm build");
  });

  it("throws 'Packages not built' when ao-core exists but dist/index.js is missing", async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("/web/node_modules/@composio/ao-core")) return true;
      if (p.endsWith("/dist/index.js")) return false;
      return false;
    });
    await expect(preflight.checkBuilt("/web")).rejects.toThrow("Packages not built");
  });

  it("only checks scoped @composio/ao-core path, never unscoped ao-core", async () => {
    // Ensure findPackageUp never looks for node_modules/ao-core (unscoped)
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p: string) => {
      checkedPaths.push(p);
      return false;
    });
    await expect(preflight.checkBuilt("/web")).rejects.toThrow();
    const unscopedChecks = checkedPaths.filter(
      (p) => p.includes("node_modules/ao-core") && !p.includes("@composio"),
    );
    expect(unscopedChecks).toHaveLength(0);
  });
});

describe("preflight.checkTmux", () => {
  it("passes when tmux is already installed", async () => {
    mockExec.mockResolvedValue({ stdout: "tmux 3.3a", stderr: "" });
    await expect(preflight.checkTmux()).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
  });

  it("throws with install instructions when tmux is missing", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    const err = await preflight.checkTmux().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("tmux is not installed");
    expect(err.message).toContain("Install it:");
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("tmux", ["-V"]);
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
    await expect(preflight.checkGhAuth()).rejects.toThrow("GitHub CLI (gh) is not installed");
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenCalledWith("gh", ["--version"]);
  });

  it("throws 'not authenticated' when gh exists but auth fails", async () => {
    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" })
      .mockRejectedValueOnce(new Error("not logged in"));
    await expect(preflight.checkGhAuth()).rejects.toThrow("GitHub CLI is not authenticated");
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("includes correct fix instructions for each failure", async () => {
    mockExec.mockRejectedValue(new Error("ENOENT"));
    await expect(preflight.checkGhAuth()).rejects.toThrow("https://cli.github.com/");

    mockExec.mockReset();

    mockExec
      .mockResolvedValueOnce({ stdout: "gh version 2.40", stderr: "" })
      .mockRejectedValueOnce(new Error("not logged in"));
    await expect(preflight.checkGhAuth()).rejects.toThrow("gh auth login");
  });
});

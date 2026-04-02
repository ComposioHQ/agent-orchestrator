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

vi.mock("node:module", () => ({
  createRequire: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

import { preflight } from "../../src/lib/preflight.js";
import { createRequire } from "node:module";

const mockCreateRequire = createRequire as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExec.mockReset();
  mockIsPortAvailable.mockReset();
  mockExistsSync.mockReset();
  mockCreateRequire.mockClear();
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
  it("returns immediately when require.resolve succeeds (package installed and built)", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi.fn().mockReturnValue("/path/to/ao-core/dist/index.js"),
    });
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
    const mockReq = mockCreateRequire.mock.results[0].value;
    expect(mockReq.resolve).toHaveBeenCalledWith("@composio/ao-core");
    // existsSync should NOT be called — require.resolve success proves the file exists
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it("works for npm global install with hoisted ao-core", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi
        .fn()
        .mockReturnValue("/usr/local/lib/node_modules/@composio/ao-core/dist/index.js"),
    });
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@composio/ao-web"),
    ).resolves.toBeUndefined();
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it("throws 'not built' when require.resolve fails but package dir exists without dist", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Cannot find module");
      }),
    });
    // findPackageUp checks node_modules/@composio/ao-core — found
    // then existsSync checks dist/index.js inside it — not found
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("/web/node_modules/@composio/ao-core")) return true;
      if (p.endsWith("/dist/index.js")) return false;
      return false;
    });
    await expect(preflight.checkBuilt("/web")).rejects.toThrow("Packages not built");
  });

  it("throws npm hint when ao-core not found in global install", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Cannot find module");
      }),
    });
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@composio/ao-web"),
    ).rejects.toThrow("npm install -g @composio/ao@latest");
  });

  it("throws pnpm hint when ao-core not found in monorepo", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Cannot find module");
      }),
    });
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/home/user/agent-orchestrator/packages/web"),
    ).rejects.toThrow("pnpm install && pnpm build");
  });

  it("passes when require.resolve fails but findPackageUp finds dir with dist", async () => {
    mockCreateRequire.mockReturnValue({
      resolve: vi.fn().mockImplementation(() => {
        throw new Error("Cannot find module");
      }),
    });
    // findPackageUp finds the directory, and dist/index.js exists inside it
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith("/web/node_modules/@composio/ao-core")) return true;
      if (p.endsWith("/dist/index.js")) return true;
      return false;
    });
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
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

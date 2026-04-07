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

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  isInstalledUnderNodeModules: (path: string) =>
    path.includes("/node_modules/") || path.includes("\\node_modules\\"),
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
  it("passes when ao-core and dist exist at webDir level (pnpm layout)", async () => {
    // findPackageUp finds ao-core on first check (pnpm symlink in webDir/node_modules)
    mockExistsSync.mockReturnValue(true);
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it("finds ao-core when hoisted one level up (npm global install layout)", async () => {
    // /web/node_modules/@aoagents/ao-core     — miss
    // /node_modules/@aoagents/ao-core         — hit
    // /node_modules/@aoagents/ao-core/dist/index.js — exists
    // /web/.next/BUILD_ID and /web/dist-server/start-all.js — exist
    mockExistsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    await expect(preflight.checkBuilt("/web")).resolves.toBeUndefined();
  });

  it("throws npm hint when ao-core not found in global install", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@aoagents/ao-web"),
    ).rejects.toThrow("npm install -g @aoagents/ao@latest");
  });

  it("throws pnpm hint when ao-core not found in monorepo", async () => {
    mockExistsSync.mockReturnValue(false);
    await expect(
      preflight.checkBuilt("/home/user/agent-orchestrator/packages/web"),
    ).rejects.toThrow("pnpm install && pnpm build");
  });

  it("throws 'pnpm build' when ao-core exists but dist is missing", async () => {
    // findPackageUp finds ao-core, but dist/index.js is missing
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(preflight.checkBuilt("/web")).rejects.toThrow(
      "Packages not built",
    );
  });

  it("throws when web production artifacts are missing", async () => {
    // findPackageUp finds ao-core, dist/index.js exists, but .next/BUILD_ID missing
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(preflight.checkBuilt("/web")).rejects.toThrow(
      "Packages not built",
    );
  });

  it("throws npm hint when web artifacts missing in global install", async () => {
    // ao-core found at first check, dist exists, but .next/BUILD_ID missing
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@aoagents/ao-web"),
    ).rejects.toThrow("npm install -g @aoagents/ao@latest");
  });

  it("throws npm hint when ao-core dist is missing in global install", async () => {
    // ao-core found, but dist/index.js missing
    mockExistsSync
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(
      preflight.checkBuilt("/usr/local/lib/node_modules/@aoagents/ao-web"),
    ).rejects.toThrow("npm install -g @aoagents/ao@latest");
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

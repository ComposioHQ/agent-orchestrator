/**
 * Tests for lib/installer.ts — platform install-attempt tables and the
 * "try attempts until one succeeds" helper. Interactive install flows
 * (ensureGit/ensureTmux) are exercised via start.test.ts; here we cover
 * the decision logic directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecSilent, mockIsHumanCaller, mockPromptConfirm } = vi.hoisted(() => ({
  mockExecSilent: vi.fn(),
  mockIsHumanCaller: vi.fn().mockReturnValue(true),
  mockPromptConfirm: vi.fn(),
}));

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: stdin });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: stdout });
}

vi.mock("../../src/lib/shell.js", () => ({
  execSilent: mockExecSilent,
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: mockIsHumanCaller,
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: mockPromptConfirm,
}));

vi.mock("../../src/lib/cli-errors.js", () => ({
  formatCommandError: (err: Error) => err,
}));

import {
  askYesNo,
  canPromptForInstall,
  genericInstallHints,
  ghInstallAttempts,
  gitInstallAttempts,
  gitInstallHints,
  tryInstallWithAttempts,
} from "../../src/lib/installer.js";

beforeEach(() => {
  mockExecSilent.mockReset();
  mockIsHumanCaller.mockReset().mockReturnValue(true);
  mockPromptConfirm.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("genericInstallHints", () => {
  it("returns Node.js hint for node/npm", () => {
    expect(genericInstallHints("node")).toEqual(["Install Node.js/npm from https://nodejs.org/"]);
    expect(genericInstallHints("npm")).toEqual(["Install Node.js/npm from https://nodejs.org/"]);
  });

  it("returns corepack + npm fallback for pnpm", () => {
    expect(genericInstallHints("pnpm")).toHaveLength(2);
  });

  it("returns empty list for unknown commands", () => {
    expect(genericInstallHints("something-else")).toEqual([]);
  });
});

describe("platform install attempts", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p });
  }

  it("gitInstallAttempts returns brew on darwin", () => {
    setPlatform("darwin");
    const attempts = gitInstallAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].cmd).toBe("brew");
  });

  it("gitInstallAttempts returns apt + dnf on linux", () => {
    setPlatform("linux");
    const attempts = gitInstallAttempts();
    expect(attempts.map((a) => a.args[0])).toEqual(["apt-get", "dnf"]);
  });

  it("ghInstallAttempts returns winget on win32", () => {
    setPlatform("win32");
    const attempts = ghInstallAttempts();
    expect(attempts[0].cmd).toBe("winget");
    expect(attempts[0].args).toContain("GitHub.cli");
  });

  it("gitInstallHints differs per platform", () => {
    setPlatform("darwin");
    expect(gitInstallHints()).toEqual(["brew install git"]);
    setPlatform("linux");
    expect(gitInstallHints()[0]).toContain("apt");
  });
});

describe("canPromptForInstall", () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
  });

  it("is false for non-human callers even on a TTY", () => {
    mockIsHumanCaller.mockReturnValue(false);
    setTTY(true, true);
    expect(canPromptForInstall()).toBe(false);
  });

  it("is false without a TTY", () => {
    mockIsHumanCaller.mockReturnValue(true);
    setTTY(false, true);
    expect(canPromptForInstall()).toBe(false);
  });
});

describe("askYesNo", () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinTTY,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutTTY,
    });
  });

  it("returns the non-interactive default when prompting is unavailable", async () => {
    mockIsHumanCaller.mockReturnValue(false);
    await expect(askYesNo("continue?", true, false)).resolves.toBe(false);
    expect(mockPromptConfirm).not.toHaveBeenCalled();
  });

  it("delegates to promptConfirm when interactive", async () => {
    mockIsHumanCaller.mockReturnValue(true);
    setTTY(true, true);
    mockPromptConfirm.mockResolvedValue(true);
    await expect(askYesNo("continue?", false)).resolves.toBe(true);
    expect(mockPromptConfirm).toHaveBeenCalledWith("continue?", false);
  });
});

describe("tryInstallWithAttempts", () => {
  it("returns true on the first attempt that verifies", async () => {
    // runInteractiveCommand uses spawn, which we can't easily mock here —
    // test the "verify already true after 0 attempts" path by passing an
    // empty list and a verify() that returns true.
    const verify = vi.fn().mockResolvedValue(true);
    await expect(tryInstallWithAttempts([], verify)).resolves.toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("returns false when verify never succeeds and no attempts are provided", async () => {
    const verify = vi.fn().mockResolvedValue(false);
    await expect(tryInstallWithAttempts([], verify)).resolves.toBe(false);
  });
});

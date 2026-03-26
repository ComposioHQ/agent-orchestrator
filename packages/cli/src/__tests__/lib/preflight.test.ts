import { describe, it, expect, vi, beforeEach } from "vitest";
import { preflight } from "../../lib/preflight.js";
import { exec } from "../../lib/shell.js";

vi.mock("../../lib/shell.js", () => ({
  exec: vi.fn(),
}));

describe("preflight", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("checkGit", () => {
    it("should resolve if git is installed", async () => {
      vi.mocked(exec).mockResolvedValue({ stdout: "git version 2.34.1", stderr: "" });
      await expect(preflight.checkGit()).resolves.not.toThrow();
      expect(exec).toHaveBeenCalledWith("git", ["--version"]);
    });

    it("should throw if git is missing", async () => {
      vi.mocked(exec).mockRejectedValue(new Error("command not found"));
      await expect(preflight.checkGit()).rejects.toThrow("git is not installed");
    });
  });

  describe("checkTtyd", () => {
    it("should resolve if ttyd is installed", async () => {
      vi.mocked(exec).mockResolvedValue({ stdout: "ttyd version 1.7.3", stderr: "" });
      await expect(preflight.checkTtyd()).resolves.not.toThrow();
      expect(exec).toHaveBeenCalledWith("ttyd", ["--version"]);
    });

    it("should throw if ttyd is missing", async () => {
      vi.mocked(exec).mockRejectedValue(new Error("command not found"));
      await expect(preflight.checkTtyd()).rejects.toThrow("ttyd is not installed");
    });
  });

  describe("checkTmux", () => {
    it("should resolve if tmux is installed", async () => {
      vi.mocked(exec).mockResolvedValue({ stdout: "tmux 3.2a", stderr: "" });
      await expect(preflight.checkTmux()).resolves.not.toThrow();
    });

    it("should throw if tmux is missing", async () => {
      vi.mocked(exec).mockRejectedValue(new Error("command not found"));
      await expect(preflight.checkTmux()).rejects.toThrow("tmux is not installed");
    });
  });
});

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  generateSessionName,
  generateSessionPrefix,
  generateTmuxName,
  getArchiveDir,
  getFeedbackReportsDir,
  getOriginFilePath,
  getProjectBaseDir,
  getSessionsDir,
  getWorktreesDir,
  parseTmuxName,
} from "../paths.js";

describe("paths", () => {
  const storageKey = "aaaaaaaaaaaa";
  const baseDir = join(process.env["HOME"] ?? "", ".agent-orchestrator", storageKey);

  it("returns storage-key scoped directories", () => {
    expect(getProjectBaseDir(storageKey)).toBe(baseDir);
    expect(getSessionsDir(storageKey)).toBe(join(baseDir, "sessions"));
    expect(getWorktreesDir(storageKey)).toBe(join(baseDir, "worktrees"));
    expect(getFeedbackReportsDir(storageKey)).toBe(join(baseDir, "feedback-reports"));
    expect(getArchiveDir(storageKey)).toBe(join(baseDir, "sessions", "archive"));
    expect(getOriginFilePath(storageKey)).toBe(join(baseDir, ".origin"));
  });

  it("keeps session prefix generation unchanged", () => {
    expect(generateSessionPrefix("agent-orchestrator")).toBe("ao");
    expect(generateSessionPrefix("Integrator")).toBe("int");
    expect(generateSessionName("ao", 7)).toBe("ao-7");
  });

  it("uses the storage key as the tmux hash segment", () => {
    const tmuxName = generateTmuxName(storageKey, "ao", 3);
    expect(tmuxName).toBe("aaaaaaaaaaaa-ao-3");
    expect(parseTmuxName(tmuxName)).toEqual({
      hash: storageKey,
      prefix: "ao",
      num: 3,
    });
  });

  it("keeps parseTmuxName strict about the 12-hex storage key", () => {
    expect(parseTmuxName("not-a-key-ao-1")).toBeNull();
    expect(parseTmuxName("abc-ao-1")).toBeNull();
  });
});

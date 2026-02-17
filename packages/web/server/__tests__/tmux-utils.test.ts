/**
 * Unit tests for tmux-utils.
 *
 * These test actual behavior by injecting mock execFileSync functions,
 * verifying the logic handles all edge cases correctly.
 */

import { describe, it, expect, vi } from "vitest";
import { findTmux, resolveTmuxSession, validateSessionId } from "../tmux-utils.js";

describe("validateSessionId", () => {
  it("accepts alphanumeric IDs", () => {
    expect(validateSessionId("ao-15")).toBe(true);
    expect(validateSessionId("ao_orchestrator")).toBe(true);
    expect(validateSessionId("session123")).toBe(true);
  });

  it("accepts hash-prefixed IDs", () => {
    expect(validateSessionId("8474d6f29887-ao-15")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSessionId("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(validateSessionId("../etc/passwd")).toBe(false);
    expect(validateSessionId("ao-15/../../secret")).toBe(false);
  });

  it("rejects shell injection attempts", () => {
    expect(validateSessionId("ao-15; rm -rf /")).toBe(false);
    expect(validateSessionId("ao-15$(whoami)")).toBe(false);
    expect(validateSessionId("ao-15`id`")).toBe(false);
  });

  it("rejects whitespace", () => {
    expect(validateSessionId("ao 15")).toBe(false);
    expect(validateSessionId("ao\t15")).toBe(false);
    expect(validateSessionId("ao\n15")).toBe(false);
  });
});

describe("findTmux", () => {
  it("returns first candidate that succeeds", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw new Error("not found"); }) // /opt/homebrew/bin/tmux
      .mockImplementationOnce(() => "tmux 3.4") // /usr/local/bin/tmux succeeds
      .mockImplementationOnce(() => "tmux 3.4"); // /usr/bin/tmux (not reached)

    const result = findTmux(mockExec);

    expect(result).toBe("/usr/local/bin/tmux");
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledWith("/opt/homebrew/bin/tmux", ["-V"], { timeout: 5000 });
    expect(mockExec).toHaveBeenCalledWith("/usr/local/bin/tmux", ["-V"], { timeout: 5000 });
  });

  it("returns /opt/homebrew/bin/tmux on macOS ARM", () => {
    const mockExec = vi.fn().mockReturnValue("tmux 3.4");

    const result = findTmux(mockExec);

    expect(result).toBe("/opt/homebrew/bin/tmux");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("falls back to bare 'tmux' when no candidates found", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });

    const result = findTmux(mockExec);

    expect(result).toBe("tmux");
    expect(mockExec).toHaveBeenCalledTimes(3); // Tried all 3 candidates
  });

  it("checks all three standard locations", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not found");
    });

    findTmux(mockExec);

    expect(mockExec).toHaveBeenCalledWith("/opt/homebrew/bin/tmux", ["-V"], { timeout: 5000 });
    expect(mockExec).toHaveBeenCalledWith("/usr/local/bin/tmux", ["-V"], { timeout: 5000 });
    expect(mockExec).toHaveBeenCalledWith("/usr/bin/tmux", ["-V"], { timeout: 5000 });
  });
});

describe("resolveTmuxSession", () => {
  const TMUX = "/opt/homebrew/bin/tmux";

  it("returns sessionId for exact match", () => {
    const mockExec = vi.fn().mockReturnValue("");

    const result = resolveTmuxSession("ao-orchestrator", TMUX, mockExec);

    expect(result).toBe("ao-orchestrator");
    // Should use = prefix for exact matching
    expect(mockExec).toHaveBeenCalledWith(
      TMUX,
      ["has-session", "-t", "=ao-orchestrator"],
      { timeout: 5000 },
    );
  });

  it("uses = prefix to prevent tmux prefix matching", () => {
    // This is the critical bugbot fix: without =, "ao-1" matches "ao-15"
    const mockExec = vi.fn().mockReturnValue("");

    resolveTmuxSession("ao-1", TMUX, mockExec);

    // Must pass "=ao-1" not "ao-1" to has-session
    expect(mockExec).toHaveBeenCalledWith(
      TMUX,
      ["has-session", "-t", "=ao-1"],
      { timeout: 5000 },
    );
  });

  it("resolves hash-prefixed session when exact match fails", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        // has-session fails (no exact match)
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        // list-sessions returns hash-prefixed sessions
        return "8474d6f29887-ao-15\n8474d6f29887-ao-16\nao-orchestrator\n";
      });

    const result = resolveTmuxSession("ao-15", TMUX, mockExec);

    expect(result).toBe("8474d6f29887-ao-15");
  });

  it("does NOT match ao-1 to 8474d6f29887-ao-15 (suffix match is exact)", () => {
    // The suffix match looks for endsWith("-ao-1"), which should NOT match "-ao-15"
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        return "8474d6f29887-ao-15\n8474d6f29887-ao-16\n";
      });

    const result = resolveTmuxSession("ao-1", TMUX, mockExec);

    // Should NOT match ao-15 or ao-16
    expect(result).toBeNull();
  });

  it("returns null when no session matches", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        return "some-other-session\nanother-session\n";
      });

    const result = resolveTmuxSession("ao-99", TMUX, mockExec);

    expect(result).toBeNull();
  });

  it("returns null when tmux is not running", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("no server running on /tmp/tmux-501/default");
    });

    const result = resolveTmuxSession("ao-15", TMUX, mockExec);

    expect(result).toBeNull();
  });

  it("returns null when list-sessions returns empty", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        return "\n";
      });

    const result = resolveTmuxSession("ao-15", TMUX, mockExec);

    expect(result).toBeNull();
  });

  it("handles multiple hash-prefixed sessions and picks the right one", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        return [
          "abc123-ao-1",
          "def456-ao-15",
          "ghi789-ao-2",
          "jkl012-ao-orchestrator",
        ].join("\n") + "\n";
      });

    expect(resolveTmuxSession("ao-15", TMUX, mockExec)).toBe("def456-ao-15");
  });

  it("handles multiple hash-prefixed sessions without cross-matching", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("session not found");
      })
      .mockImplementationOnce(() => {
        return [
          "abc123-ao-1",
          "def456-ao-15",
          "ghi789-ao-2",
        ].join("\n") + "\n";
      });

    // ao-1 should match abc123-ao-1, NOT def456-ao-15
    expect(resolveTmuxSession("ao-1", TMUX, mockExec)).toBe("abc123-ao-1");
  });

  it("prefers exact match over hash-prefixed match", () => {
    // If "ao-15" exists as both exact and hash-prefixed, return exact
    const mockExec = vi.fn().mockReturnValue("");

    const result = resolveTmuxSession("ao-15", TMUX, mockExec);

    expect(result).toBe("ao-15");
    // Should only call has-session, not list-sessions
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

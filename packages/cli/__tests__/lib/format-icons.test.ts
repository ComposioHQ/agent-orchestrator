import { describe, it, expect } from "vitest";
import chalk from "chalk";
import {
  ciStatusIcon,
  reviewDecisionIcon,
  activityIcon,
  padCol,
} from "../../src/lib/format.js";

// =============================================================================
// ciStatusIcon
// =============================================================================

describe("ciStatusIcon", () => {
  it('returns green "pass" for passing', () => {
    const result = ciStatusIcon("passing");
    expect(result).toBe(chalk.green("pass"));
  });

  it('returns red "fail" for failing', () => {
    const result = ciStatusIcon("failing");
    expect(result).toBe(chalk.red("fail"));
  });

  it('returns yellow "pend" for pending', () => {
    const result = ciStatusIcon("pending");
    expect(result).toBe(chalk.yellow("pend"));
  });

  it('returns dim "-" for none', () => {
    const result = ciStatusIcon("none");
    expect(result).toBe(chalk.dim("-"));
  });

  it('returns dim "-" for null', () => {
    const result = ciStatusIcon(null);
    expect(result).toBe(chalk.dim("-"));
  });
});

// =============================================================================
// reviewDecisionIcon
// =============================================================================

describe("reviewDecisionIcon", () => {
  it('returns green "ok" for approved', () => {
    const result = reviewDecisionIcon("approved");
    expect(result).toBe(chalk.green("ok"));
  });

  it('returns red "chg!" for changes_requested', () => {
    const result = reviewDecisionIcon("changes_requested");
    expect(result).toBe(chalk.red("chg!"));
  });

  it('returns yellow "rev?" for pending', () => {
    const result = reviewDecisionIcon("pending");
    expect(result).toBe(chalk.yellow("rev?"));
  });

  it('returns dim "-" for none', () => {
    const result = reviewDecisionIcon("none");
    expect(result).toBe(chalk.dim("-"));
  });

  it('returns dim "-" for null', () => {
    const result = reviewDecisionIcon(null);
    expect(result).toBe(chalk.dim("-"));
  });
});

// =============================================================================
// activityIcon
// =============================================================================

describe("activityIcon", () => {
  it('returns green "working" for active', () => {
    const result = activityIcon("active");
    expect(result).toBe(chalk.green("working"));
  });

  it('returns cyan "ready" for ready', () => {
    const result = activityIcon("ready");
    expect(result).toBe(chalk.cyan("ready"));
  });

  it('returns yellow "idle" for idle', () => {
    const result = activityIcon("idle");
    expect(result).toBe(chalk.yellow("idle"));
  });

  it('returns magenta "waiting" for waiting_input', () => {
    const result = activityIcon("waiting_input");
    expect(result).toBe(chalk.magenta("waiting"));
  });

  it('returns red "blocked" for blocked', () => {
    const result = activityIcon("blocked");
    expect(result).toBe(chalk.red("blocked"));
  });

  it('returns dim "exited" for exited', () => {
    const result = activityIcon("exited");
    expect(result).toBe(chalk.dim("exited"));
  });

  it('returns dim "unknown" for null', () => {
    const result = activityIcon(null);
    expect(result).toBe(chalk.dim("unknown"));
  });
});

// =============================================================================
// padCol
// =============================================================================

describe("padCol", () => {
  it("pads short strings to specified width", () => {
    const result = padCol("hi", 10);
    expect(result).toBe("hi        ");
    expect(result.length).toBe(10);
  });

  it("truncates long strings with ellipsis", () => {
    const result = padCol("hello world from here", 10);
    // Should be 9 visible chars + ellipsis = 10
    expect(result.length).toBe(10);
    expect(result).toContain("\u2026"); // ellipsis
  });

  it("handles exact-width strings", () => {
    const result = padCol("0123456789", 10);
    expect(result).toBe("0123456789");
    expect(result.length).toBe(10);
  });

  it("handles strings with ANSI codes correctly", () => {
    const colored = chalk.green("hi");
    const result = padCol(colored, 10);
    // The visible length should be 10, but the actual string is longer due to ANSI codes
    const visibleLength = result.replace(/\u001b\[[0-9;]*m/g, "").length;
    expect(visibleLength).toBe(10);
  });

  it("handles empty string", () => {
    const result = padCol("", 5);
    expect(result).toBe("     ");
    expect(result.length).toBe(5);
  });

  it("truncates ANSI-colored long strings based on visible length", () => {
    // Green text that is longer than width when visible
    const colored = chalk.green("very long text here");
    const result = padCol(colored, 8);
    // Strip ANSI to check visible output
    const visible = result.replace(/\u001b\[[0-9;]*m/g, "");
    expect(visible.length).toBe(8);
  });
});

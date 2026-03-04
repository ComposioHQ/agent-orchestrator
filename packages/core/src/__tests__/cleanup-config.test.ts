/**
 * Unit tests for cleanup and backpressure config types and Zod schemas.
 *
 * Verifies that sensible defaults are applied when sections are omitted,
 * and that partial overrides merge correctly with defaults.
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../config.js";

/** Minimal valid config — just one project, no cleanup/backpressure sections */
function minimalConfig(overrides?: Record<string, unknown>) {
  return {
    projects: {
      testproj: {
        path: "/repos/test",
        repo: "org/test",
      },
    },
    ...overrides,
  };
}

describe("CleanupConfig defaults", () => {
  it("applies cleanup defaults when section is omitted", () => {
    const config = validateConfig(minimalConfig());

    expect(config.cleanup).toEqual({
      enabled: true,
      branchPrefix: "feat/agent-",
      sweepInterval: 10,
    });
  });
});

describe("BackpressureConfig defaults", () => {
  it("applies backpressure defaults when section is omitted", () => {
    const config = validateConfig(minimalConfig());

    expect(config.backpressure).toEqual({
      enabled: true,
      pauseOnOpenPrs: true,
      pauseOnOpenIssues: true,
    });
  });
});

describe("CleanupConfig overrides", () => {
  it("merges partial overrides with defaults", () => {
    const config = validateConfig(
      minimalConfig({
        cleanup: {
          enabled: false,
          sweepInterval: 20,
          // branchPrefix omitted — should get default
        },
      }),
    );

    expect(config.cleanup).toEqual({
      enabled: false,
      branchPrefix: "feat/agent-",
      sweepInterval: 20,
    });
  });
});

describe("BackpressureConfig overrides", () => {
  it("merges partial overrides with defaults", () => {
    const config = validateConfig(
      minimalConfig({
        backpressure: {
          pauseOnOpenIssues: false,
          // enabled and pauseOnOpenPrs omitted — should get defaults
        },
      }),
    );

    expect(config.backpressure).toEqual({
      enabled: true,
      pauseOnOpenPrs: true,
      pauseOnOpenIssues: false,
    });
  });
});

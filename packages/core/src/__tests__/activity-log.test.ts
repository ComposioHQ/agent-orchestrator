import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkActivityLogState,
  classifyTerminalActivity,
  readLastActivityEntry,
  recordTerminalActivity,
  ACTIVITY_INPUT_STALENESS_MS,
} from "../activity-log.js";
import type { ActivityState } from "../types.js";

const { mockAppendFile, mockMkdir } = vi.hoisted(() => ({
  mockAppendFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  };
});

describe("classifyTerminalActivity", () => {
  it("returns active state with no trigger", () => {
    const detect = () => "active" as ActivityState;
    const result = classifyTerminalActivity("some output", detect);
    expect(result).toEqual({ state: "active", trigger: undefined });
  });

  it("returns waiting_input with trigger from last 3 lines", () => {
    const detect = () => "waiting_input" as ActivityState;
    const result = classifyTerminalActivity("line1\nline2\nprompt?", detect);
    expect(result.state).toBe("waiting_input");
    expect(result.trigger).toContain("prompt?");
  });

  it("returns blocked with trigger", () => {
    const detect = () => "blocked" as ActivityState;
    const result = classifyTerminalActivity("error occurred", detect);
    expect(result.state).toBe("blocked");
    expect(result.trigger).toBeDefined();
  });
});

describe("checkActivityLogState", () => {
  it("returns null for null input", () => {
    expect(checkActivityLogState(null)).toBeNull();
  });

  it("returns waiting_input when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked when entry is fresh", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result?.state).toBe("blocked");
  });

  it("returns null for stale waiting_input entry", () => {
    const staleTs = new Date(Date.now() - ACTIVITY_INPUT_STALENESS_MS - 1000).toISOString();
    const result = checkActivityLogState({
      entry: { ts: staleTs, state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });

  it("returns null for non-critical states", () => {
    const result = checkActivityLogState({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });

  it("returns null for invalid entry.ts", () => {
    const result = checkActivityLogState({
      entry: { ts: "not-a-date", state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });
    expect(result).toBeNull();
  });
});

describe("readLastActivityEntry", () => {
  it("returns null when file does not exist", async () => {
    const result = await readLastActivityEntry("/nonexistent/path");
    expect(result).toBeNull();
  });
});

describe("recordTerminalActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes activity entry for active state", async () => {
    const detect = () => "active" as ActivityState;
    await recordTerminalActivity("/workspace", "output", detect);
    expect(mockAppendFile).toHaveBeenCalledOnce();
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.state).toBe("active");
    expect(written.source).toBe("terminal");
  });

  it("always writes waiting_input immediately", async () => {
    const detect = () => "waiting_input" as ActivityState;
    await recordTerminalActivity("/workspace", "prompt?", detect);
    expect(mockAppendFile).toHaveBeenCalledOnce();
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.state).toBe("waiting_input");
    expect(written.trigger).toBeDefined();
  });

  it("always writes blocked immediately", async () => {
    const detect = () => "blocked" as ActivityState;
    await recordTerminalActivity("/workspace", "error", detect);
    expect(mockAppendFile).toHaveBeenCalledOnce();
  });
});

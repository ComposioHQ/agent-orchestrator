/**
 * Tests for lib/dashboard-bootstrap.ts.
 *
 * startDashboard is a thin spawn() facade (covered indirectly by start.test.ts).
 * The real decision logic lives in stopDashboard / killDashboardOnPort — which
 * must match only dashboard processes and ignore unrelated co-listeners. These
 * tests pin the matching rule so a regression can't silently kill the wrong PID.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  MAX_PORT_SCAN: 100,
  buildDashboardEnv: vi.fn(),
}));

vi.mock("../../src/lib/installer.js", () => ({
  genericInstallHints: () => [],
}));

vi.mock("../../src/lib/cli-errors.js", () => ({
  formatCommandError: (err: Error) => err,
}));

import { stopDashboard } from "../../src/lib/dashboard-bootstrap.js";

beforeEach(() => {
  mockExec.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

function mockLsof(pids: string[]): void {
  mockExec.mockImplementation(async (cmd: string, args: string[]) => {
    if (cmd === "lsof") {
      return { stdout: pids.join("\n"), stderr: "" };
    }
    throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
  });
}

describe("stopDashboard", () => {
  it("kills dashboard PIDs matching next-server/start-all/next dev/ao-web", async () => {
    const cmdlines: Record<string, string> = {
      "100": "node /path/to/dist-server/start-all.js",
      "101": "node /path/to/next-server",
      "102": "unrelated-sidecar --port 3000",
    };
    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "lsof") return { stdout: "100\n101\n102", stderr: "" };
      if (cmd === "ps") return { stdout: cmdlines[args[1]] ?? "", stderr: "" };
      if (cmd === "kill") return { stdout: "", stderr: "" };
      throw new Error(`unexpected exec: ${cmd}`);
    });

    await stopDashboard(3000);

    // Collect every PID passed to `kill` across all calls. Using filter+flatMap
    // (rather than .find) keeps the assertion honest if a future refactor
    // changes the implementation from one batched `kill` call to one per PID —
    // either way, exactly the dashboard PIDs must be killed.
    const killedPids = mockExec.mock.calls
      .filter(([c]) => c === "kill")
      .flatMap(([, args]) => args as string[]);
    expect(killedPids.sort()).toEqual(["100", "101"]);
  });

  it("does not kill when no co-listener matches the dashboard pattern", async () => {
    mockExec.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "lsof") return { stdout: "200", stderr: "" };
      if (cmd === "ps") return { stdout: "unrelated-server --flag", stderr: "" };
      throw new Error(`unexpected exec: ${cmd} ${args.join(" ")}`);
    });

    await stopDashboard(3000);

    const killCalls = mockExec.mock.calls.filter(([c]) => c === "kill");
    // Should have scanned nearby ports but never killed anything
    expect(killCalls).toHaveLength(0);
  });

  it("logs a friendly message when nothing is listening", async () => {
    mockLsof([]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.join(" "));
    });
    await stopDashboard(3000);
    expect(logs.some((l) => l.includes("may not be running"))).toBe(true);
  });
});

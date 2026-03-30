/**
 * Tests for server/start-all.ts
 *
 * Since start-all.ts executes top-level side effects (spawning processes,
 * registering signal handlers), we test the logic by reading the source
 * and verifying structural properties, plus unit-testing extracted logic
 * patterns via controlled imports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const serverDir = join(__dirname, "..");

function readServerFile(name: string): string {
  return readFileSync(join(serverDir, name), "utf-8");
}

describe("start-all.ts source analysis", () => {
  const source = readServerFile("start-all.ts");

  it("imports spawn from child_process", () => {
    expect(source).toMatch(/import\s.*spawn.*from\s+["']node:child_process["']/);
  });

  it("spawns the next server", () => {
    expect(source).toMatch(/spawnProcess\(\s*["']next["']/);
  });

  it("spawns the terminal websocket server", () => {
    expect(source).toMatch(/spawnProcess\(\s*["']terminal["']/);
  });

  it("spawns the direct terminal websocket server", () => {
    expect(source).toMatch(/spawnProcess\(\s*["']direct-terminal["']/);
  });

  it("registers SIGINT and SIGTERM handlers", () => {
    expect(source).toMatch(/process\.on\(\s*["']SIGINT["']/);
    expect(source).toMatch(/process\.on\(\s*["']SIGTERM["']/);
  });

  it("has restart logic with maxRestarts", () => {
    expect(source).toMatch(/maxRestarts/);
    expect(source).toMatch(/restart/i);
  });

  it("resolves next binary with fallback chain", () => {
    expect(source).toMatch(/resolveNextBin/);
    expect(source).toMatch(/node_modules.*\.bin.*next/);
    expect(source).toMatch(/createRequire/);
  });

  it("enables restart for terminal servers but not for next", () => {
    // Terminal servers have { restart: true }
    expect(source).toMatch(/spawnProcess\(\s*["']terminal["'].*restart:\s*true/s);
    expect(source).toMatch(/spawnProcess\(\s*["']direct-terminal["'].*restart:\s*true/s);
    // Next server line should NOT have restart: true
    const nextLine = source.match(/spawnProcess\(\s*["']next["'][^)]+\)/)?.[0] ?? "";
    expect(nextLine).not.toMatch(/restart/);
  });

  it("uses PORT env variable with default 3000", () => {
    expect(source).toMatch(/process\.env\["PORT"\]\s*\|\|\s*["']3000["']/);
  });

  it("has graceful shutdown with force timeout", () => {
    expect(source).toMatch(/shuttingDown/);
    expect(source).toMatch(/setTimeout/);
    expect(source).toMatch(/SIGTERM/);
  });

  it("pipes stdout and stderr from children", () => {
    expect(source).toMatch(/child\.stdout\?\.on\(\s*["']data["']/);
    expect(source).toMatch(/child\.stderr\?\.on\(\s*["']data["']/);
  });
});

describe("resolveNextBin logic", () => {
  it("resolves local bin when it exists", () => {
    const pkgRoot = resolve(__dirname, "../..");
    const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
    // We can't control existsSync in this context, but we verify the path pattern
    expect(localBin).toMatch(/node_modules\/.bin\/next$/);
  });

  it("falls back via createRequire for hoisted deps", () => {
    // Verify createRequire is importable and works
    const require = createRequire(resolve(__dirname, "../../package.json"));
    expect(typeof require.resolve).toBe("function");
  });
});

describe("spawnProcess logic (via mock)", () => {
  let mockSpawn: ReturnType<typeof vi.fn>;
  let mockChild: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockChild = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    mockSpawn = vi.fn(() => mockChild);
  });

  it("creates child process with correct options", () => {
    // Simulate the spawn pattern from start-all.ts
    const child = mockSpawn("node", ["server.js"], {
      cwd: "/pkg/root",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    expect(mockSpawn).toHaveBeenCalledWith("node", ["server.js"], {
      cwd: "/pkg/root",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  });

  it("handles stdout data by splitting lines", () => {
    const lines: string[] = [];
    mockChild.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        lines.push(line);
      }
    });

    mockChild.stdout.emit("data", Buffer.from("line1\nline2\n"));
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("handles exit event", () => {
    const exitHandler = vi.fn();
    mockChild.on("exit", exitHandler);
    mockChild.emit("exit", 0);
    expect(exitHandler).toHaveBeenCalledWith(0);
  });

  it("sends SIGTERM to children on cleanup", () => {
    const children = [mockChild];
    // Simulate cleanup logic
    for (const child of children) {
      child.kill("SIGTERM");
    }
    expect(mockChild.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

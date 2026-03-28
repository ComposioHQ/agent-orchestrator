import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "open-iterm-tab");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeOsascript(binDir: string, logFile: string): void {
  writeExecutable(
    join(binDir, "osascript"),
    [
      "#!/bin/bash",
      "set -e",
      `LOG_FILE=${JSON.stringify(logFile)}`,
      `COUNT_FILE=${JSON.stringify(`${logFile}.count`)}`,
      "count=0",
      'if [ -f "$COUNT_FILE" ]; then',
      '  count=$(cat "$COUNT_FILE")',
      "fi",
      "count=$((count + 1))",
      'printf "%s" "$count" > "$COUNT_FILE"',
      'printf "%s\\n---\\n" "$2" >> "$LOG_FILE"',
      'if [ "$count" -eq 1 ]; then',
      '  printf "NOT_FOUND\\n"',
      "else",
      '  printf "OK\\n"',
      "fi",
    ].join("\n"),
  );
}

function createFakeTmux(binDir: string, logFile: string): void {
  writeExecutable(
    join(binDir, "tmux"),
    [
      "#!/bin/bash",
      "set -e",
      `printf "%s\\n" "$*" >> ${JSON.stringify(logFile)}`,
      'if [ "$1" = "has-session" ]; then',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
}

describe("scripts/open-iterm-tab", () => {
  it("supports the legacy tmux session form", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-open-iterm-script-"));
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const osascriptLog = join(tempRoot, "osascript.log");
    const tmuxLog = join(tempRoot, "tmux.log");
    createFakeOsascript(binDir, osascriptLog);
    createFakeTmux(binDir, tmuxLog);

    const result = spawnSync("bash", [scriptPath, "app-1"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
      },
      encoding: "utf8",
    });

    const osascriptOutput = readFileSync(osascriptLog, "utf8");
    const tmuxOutput = readFileSync(tmuxLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(tmuxOutput).toContain("has-session -t app-1");
    expect(osascriptOutput).toContain('if name of aSession is equal to "app-1"');
    expect(osascriptOutput).toContain("tmux attach -t 'app-1'");
  });

  it("supports runtime-aware title/command mode without tmux lookup", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-open-iterm-runtime-"));
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const osascriptLog = join(tempRoot, "osascript.log");
    const tmuxLog = join(tempRoot, "tmux.log");
    createFakeOsascript(binDir, osascriptLog);
    createFakeTmux(binDir, tmuxLog);

    const result = spawnSync(
      "bash",
      [
        scriptPath,
        "--title",
        "container-1",
        "--command",
        "docker exec -it container-1 tmux attach -t tmux-1",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ""}`,
        },
        encoding: "utf8",
      },
    );

    const osascriptOutput = readFileSync(osascriptLog, "utf8");
    const tmuxOutput = existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "";
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(tmuxOutput).toBe("");
    expect(osascriptOutput).toContain('set name to "container-1"');
    expect(osascriptOutput).toContain("docker exec -it container-1 tmux attach -t tmux-1");
  });
});

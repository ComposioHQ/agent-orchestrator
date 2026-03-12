import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = "/home/harsh/.worktrees/agent-orchestrator/ao-69";
const scriptPath = join(repoRoot, "scripts", "ao-update.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

describe("scripts/ao-update.sh", () => {
  it("runs the expected fetch, rebuild, and launcher refresh flow", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-script-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "cli"), { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    createFakeBinary(
      binDir,
      "git",
      `printf 'git %s\\n' "$*" >> ${JSON.stringify(commandLog)}\ncase "$*" in\n  "rev-parse --is-inside-work-tree") printf 'true\\n' ;;
  "status --porcelain") ;;
  "branch --show-current") printf 'main\\n' ;;
  "fetch origin main") ;;
  "pull --ff-only origin main") ;;
  *) ;;
esac\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf '9.15.4\\n'\nfi\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}\nif [ "$1" = "--version" ]; then\n  printf 'v20.11.1\\n'\nfi\nexit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--skip-smoke"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain("git fetch origin main");
    expect(commands).toContain("git pull --ff-only origin main");
    expect(commands).toContain("pnpm install");
    expect(commands).toContain("pnpm --filter @composio/ao-core clean");
    expect(commands).toContain("pnpm --filter @composio/ao-cli build");
    expect(commands).toContain("npm link");
  });

  it("runs the built-in smoke commands in smoke-only mode", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-smoke-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(join(fakeRepo, "packages", "agent-orchestrator", "bin"), { recursive: true });
    writeFileSync(
      join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js"),
      "#!/usr/bin/env node\n",
    );

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    const commandLog = join(tempRoot, "commands.log");

    createFakeBinary(
      binDir,
      "git",
      `if [ "$*" = "--version" ]; then printf 'git version 2.43.0\\n'; fi
printf 'git %s\\n' "$*" >> ${JSON.stringify(commandLog)}
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      `if [ "$1" = "--version" ]; then printf '9.15.4\\n'; fi
printf 'pnpm %s\\n' "$*" >> ${JSON.stringify(commandLog)}
exit 0`,
    );
    createFakeBinary(
      binDir,
      "npm",
      `printf 'npm %s\\n' "$*" >> ${JSON.stringify(commandLog)}
exit 0`,
    );
    createFakeBinary(
      binDir,
      "node",
      `if [ "$1" = "--version" ]; then printf 'v20.11.1\\n'; fi
printf 'node %s\\n' "$*" >> ${JSON.stringify(commandLog)}
exit 0`,
    );

    const result = spawnSync("bash", [scriptPath, "--smoke-only"], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    const commands = readFileSync(commandLog, "utf8");
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js")} --version`,
    );
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js")} doctor --help`,
    );
    expect(commands).toContain(
      `node ${join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js")} update --help`,
    );
  });

  it("fails fast on a dirty install repo with an actionable message", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-update-dirty-"));
    const fakeRepo = join(tempRoot, "repo");
    mkdirSync(fakeRepo, { recursive: true });

    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });

    createFakeBinary(
      binDir,
      "git",
      `case "$*" in
  "rev-parse --is-inside-work-tree") printf "true\\n" ;;
  "status --porcelain") printf " M README.md\\n" ;;
  "branch --show-current") printf "main\\n" ;;
esac
exit 0`,
    );
    createFakeBinary(
      binDir,
      "pnpm",
      'if [ "$1" = "--version" ]; then printf "9.15.4\\n"; fi\nexit 0',
    );
    createFakeBinary(binDir, "npm", "exit 0");
    createFakeBinary(
      binDir,
      "node",
      'if [ "$1" = "--version" ]; then printf "v20.11.1\\n"; fi\nexit 0',
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        AO_REPO_ROOT: fakeRepo,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Working tree is dirty");
    expect(result.stderr).toContain("commit or stash");
  });
});

import { describe, it, expect } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const scriptPath = join(repoRoot, "scripts", "ao-doctor.sh");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function createFakeBinary(binDir: string, name: string, body: string): void {
  writeExecutable(join(binDir, name), `#!/bin/bash\nset -e\n${body}\n`);
}

function createHealthyRepo(tempRoot: string): string {
  const fakeRepo = join(tempRoot, "repo");
  mkdirSync(join(fakeRepo, "node_modules"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "ao"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "core", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "cli", "dist"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "agent-orchestrator", "bin"), { recursive: true });
  mkdirSync(join(fakeRepo, "packages", "web"), { recursive: true });
  writeFileSync(join(fakeRepo, "packages", "core", "dist", "index.js"), "export {};\n");
  writeFileSync(join(fakeRepo, "packages", "cli", "dist", "index.js"), "export {};\n");
  writeFileSync(
    join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js"),
    '#!/usr/bin/env node\nconsole.log("0.1.0");\n',
  );
  chmodSync(join(fakeRepo, "packages", "agent-orchestrator", "bin", "ao.js"), 0o755);
  return fakeRepo;
}

function createHealthyPath(binDir: string): void {
  createFakeBinary(
    binDir,
    "node",
    'if [ "$1" = "--version" ]; then\n  printf "v20.11.1\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "git",
    'if [ "$1" = "--version" ]; then\n  printf "git version 2.43.0\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "pnpm",
    'if [ "$1" = "--version" ]; then\n  printf "9.15.4\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "npm",
    'if [ "$1" = "bin" ]; then\n  printf "/tmp/npm-bin\\n"\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "tmux",
    'if [ "$1" = "-V" ]; then\n  printf "tmux 3.4\\n"\n  exit 0\nfi\nif [ "$1" = "list-sessions" ]; then\n  exit 1\nfi\nexit 0',
  );
  createFakeBinary(
    binDir,
    "gh",
    'if [ "$1" = "--version" ]; then\n  printf "gh version 2.50.0\\n"\n  exit 0\nfi\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  exit 0\nfi\nexit 0',
  );
  createFakeBinary(binDir, "ao", 'printf "/fake/ao\\n" >/dev/null\nexit 0');
}

function createHealthyDocker(
  binDir: string,
  options?: { rootless?: boolean; gpu?: boolean },
): void {
  const rootless = options?.rootless ?? true;
  const gpu = options?.gpu ?? false;
  createFakeBinary(
    binDir,
    "docker",
    [
      'if [ "$1" = "--version" ]; then',
      '  printf "Docker version 27.0.0\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "info" ] && [ $# -eq 1 ]; then',
      '  printf "Server: Docker Engine\\n"',
      "  exit 0",
      "fi",
      'if [ "$1" = "info" ] && [ "$2" = "--format" ]; then',
      '  if printf "%s" "$3" | grep -q "SecurityOptions"; then',
      rootless ? "    printf '[\"name=rootless\"]\\n'" : "    printf '[\"name=seccomp\"]\\n'",
      "    exit 0",
      "  fi",
      '  if printf "%s" "$3" | grep -q "Runtimes"; then',
      gpu ? '    printf \'{"runc":{},"nvidia":{}}\\n\'' : "    printf '{\"runc\":{}}\\n'",
      "    exit 0",
      "  fi",
      "fi",
      'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
      "  exit 1",
      "fi",
      'if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then',
      '  printf "{}\\n"',
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );
}

describe("scripts/ao-doctor.sh", () => {
  it("reports a healthy install as PASS", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-script-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    mkdirSync(join(tempRoot, ".agent-orchestrator"), { recursive: true });
    mkdirSync(join(tempRoot, ".worktrees"), { recursive: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    writeFileSync(configPath, "projects: {}\n");

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        HOME: tempRoot,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("Environment looks healthy");
  });

  it("applies safe fixes for missing launcher, missing dirs, and stale temp files", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-fix-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    rmSync(join(binDir, "ao"), { force: true });

    const npmLog = join(tempRoot, "npm.log");
    createFakeBinary(
      binDir,
      "npm",
      `printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}\nif [ "$1" = "bin" ]; then\n  printf "/tmp/npm-bin\\n"\nfi\nexit 0`,
    );

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    const metadataRoot = join(tempRoot, ".agent-orchestrator");
    const worktreeRoot = join(tempRoot, ".worktrees");
    const dataDir = join(tempRoot, "data");
    const worktreeDir = join(tempRoot, "worktrees");
    const commentedDataDir = `${dataDir} # session metadata`;
    const commentedWorktreeDir = `${worktreeDir} # ephemeral worktrees`;
    writeFileSync(
      configPath,
      [`dataDir: ${commentedDataDir}`, `worktreeDir: ${commentedWorktreeDir}`, "projects: {}"].join(
        "\n",
      ),
    );

    const tmpRoot = join(tempRoot, "tmp-root");
    mkdirSync(tmpRoot, { recursive: true });
    const staleFile = join(tmpRoot, "ao-stale.tmp");
    writeFileSync(staleFile, "stale\n");
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleFile, oldTimestamp, oldTimestamp);

    const result = spawnSync("bash", [scriptPath, "--fix"], {
      env: {
        ...process.env,
        PATH: `${binDir}:/bin:/usr/bin`,
        HOME: tempRoot,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
        AO_DOCTOR_TMP_ROOT: tmpRoot,
      },
      encoding: "utf8",
    });

    const npmCommands = readFileSync(npmLog, "utf8");
    const staleStillExists = existsSync(staleFile);
    const metadataRootExists = existsSync(metadataRoot);
    const worktreeRootExists = existsSync(worktreeRoot);
    const commentedDataDirExists = existsSync(commentedDataDir);
    const commentedWorktreeDirExists = existsSync(commentedWorktreeDir);
    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("FIXED");
    expect(npmCommands).toContain("link");
    expect(result.stdout).toContain("launcher");
    expect(result.stdout).toContain("stale temp files");
    expect(result.stdout).toContain("legacy and ignored");
    expect(staleStillExists).toBe(false);
    expect(metadataRootExists).toBe(true);
    expect(worktreeRootExists).toBe(true);
    expect(commentedDataDirExists).toBe(false);
    expect(commentedWorktreeDirExists).toBe(false);
  });

  it("validates docker runtime config when runtime: docker is enabled", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-docker-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    createHealthyDocker(binDir, { rootless: true, gpu: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    mkdirSync(join(tempRoot, ".agent-orchestrator"), { recursive: true });
    mkdirSync(join(tempRoot, ".worktrees"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "projects:",
        "  app:",
        "    repo: org/repo",
        "    path: ~/repo",
        "    defaultBranch: main",
        "    runtime: docker",
        "    runtimeConfig:",
        "      image: ghcr.io/composio/ao:test",
        "      gpus: all",
      ].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        HOME: tempRoot,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("docker CLI is installed");
    expect(result.stdout).toContain("docker daemon is reachable");
    expect(result.stdout).toContain(
      "docker runtime image is configured as ghcr.io/composio/ao:test",
    );
    expect(result.stdout).toContain(
      "docker image ghcr.io/composio/ao:test is available or reachable",
    );
    if (process.platform === "linux") {
      expect(result.stdout).toContain("docker appears to be running in rootless mode");
    }
    expect(result.stdout).toContain("docker advertises an nvidia runtime for GPU sessions");
  });

  it("fails when docker runtime is configured without an image", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-doctor-docker-missing-image-"));
    const fakeRepo = createHealthyRepo(tempRoot);
    const binDir = join(tempRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    createHealthyPath(binDir);
    createHealthyDocker(binDir, { rootless: true });

    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    mkdirSync(join(tempRoot, ".agent-orchestrator"), { recursive: true });
    mkdirSync(join(tempRoot, ".worktrees"), { recursive: true });
    writeFileSync(
      configPath,
      [
        "projects:",
        "  app:",
        "    repo: org/repo",
        "    path: ~/repo",
        "    defaultBranch: main",
        "    runtime: docker",
        "    runtimeConfig:",
        "      limits:",
        "        memory: 4g",
      ].join("\n"),
    );

    const result = spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        HOME: tempRoot,
        AO_REPO_ROOT: fakeRepo,
        AO_CONFIG_PATH: configPath,
      },
      encoding: "utf8",
    });

    rmSync(tempRoot, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "runtime: docker is configured but no runtimeConfig.image was found",
    );
  });
});

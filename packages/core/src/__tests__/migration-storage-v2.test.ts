import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  inventoryHashDirs,
  convertKeyValueToJson,
  detectActiveSessions,
  migrateStorage,
  rollbackStorage,
} from "../migration/storage-v2.js";
import { readMetadata } from "../metadata.js";

function createTempDir(): string {
  const dir = join(tmpdir(), `ao-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("inventoryHashDirs", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("detects hash-based directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000-myproject", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].hash).toBe("aaaaaa000000");
    expect(dirs[0].projectId).toBe("myproject");
    expect(dirs[0].empty).toBe(false);
  });

  it("marks empty directories correctly", () => {
    mkdirSync(join(testDir, "aaaaaa000000-empty-project"), { recursive: true });

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].empty).toBe(true);
  });

  it("ignores non-hash directories", () => {
    mkdirSync(join(testDir, "projects"), { recursive: true });
    mkdirSync(join(testDir, "config.yaml"), { recursive: true });
    mkdirSync(join(testDir, "not-a-hash-dir"), { recursive: true });

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(0);
  });

  it("detects multiple hash dirs for the same project", () => {
    mkdirSync(join(testDir, "aaaaaaaaaaaa-myproject", "sessions"), { recursive: true });
    mkdirSync(join(testDir, "bbbbbbbbbbbb-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaaaaaaaa-myproject", "sessions", "ao-1"), "status=working\n");
    writeFileSync(join(testDir, "bbbbbbbbbbbb-myproject", "sessions", "ao-2"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => d.projectId === "myproject")).toBe(true);
  });

  it("returns empty array for non-existent directory", () => {
    const dirs = inventoryHashDirs(join(testDir, "nonexistent"));
    expect(dirs).toHaveLength(0);
  });

  it("detects bare 12-hex hash directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    writeFileSync(
      join(testDir, "aaaaaa000000", "sessions", "ao-1"),
      "project=myproject\nstatus=working\n",
    );

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].hash).toBe("aaaaaa000000");
    // projectId derived from session metadata
    expect(dirs[0].projectId).toBe("myproject");
    expect(dirs[0].empty).toBe(false);
  });

  it("derives bare hash projectId from global config storageKey", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000", "sessions", "ao-1"), "status=working\n");

    // Write a config that maps storageKey → projectId
    const configPath = join(testDir, "config.yaml");
    writeFileSync(configPath, [
      "projects:",
      "  my-app:",
      "    path: /home/user/my-app",
      "    storageKey: aaaaaa000000",
      "",
    ].join("\n"));

    const dirs = inventoryHashDirs(testDir, configPath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("my-app");
  });

  it("falls back to hash as projectId when no config or project field", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    // Session file with no "project" field
    writeFileSync(join(testDir, "aaaaaa000000", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("aaaaaa000000");
  });

  it("skips observability directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000-observability"), { recursive: true });
    mkdirSync(join(testDir, "aaaaaa000000-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000-myproject", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("myproject");
  });

  it("skips .migrated directories (prevents .migrated.migrated on re-run)", () => {
    // Simulate post-migration state: original renamed to .migrated
    mkdirSync(join(testDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(0);
  });
});

describe("detectActiveSessions", () => {
  it("returns empty array when tmux is not available", async () => {
    // On CI or machines without tmux, this should return empty
    const sessions = await detectActiveSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

describe("convertKeyValueToJson", () => {
  it("converts basic key-value pairs", () => {
    const kv = [
      "project=myproject",
      "agent=claude-code",
      "status=working",
      "createdAt=2026-04-21T12:00:00.000Z",
      "branch=session/ao-1",
      "worktree=/home/user/.agent-orchestrator/abc-myproject/worktrees/ao-1",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["project"]).toBe("myproject");
    expect(result["agent"]).toBe("claude-code");
    expect(result["createdAt"]).toBe("2026-04-21T12:00:00.000Z");
    expect(result["branch"]).toBe("session/ao-1");
    // status preserved for pre-lifecycle sessions (no statePayload)
    expect(result["status"]).toBe("working");
  });

  it("converts statePayload to lifecycle object", () => {
    const lifecycle = {
      version: 2,
      session: { kind: "worker", state: "working" },
    };
    const kv = [
      "project=myproject",
      `statePayload=${JSON.stringify(lifecycle)}`,
      "stateVersion=2",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["lifecycle"]).toEqual(lifecycle);
    // stateVersion is dropped (lives inside lifecycle)
    expect(result).not.toHaveProperty("stateVersion");
    expect(result).not.toHaveProperty("statePayload");
  });

  it("converts prAutoDetect on/off to boolean", () => {
    expect(convertKeyValueToJson("prAutoDetect=on")["prAutoDetect"]).toBe(true);
    expect(convertKeyValueToJson("prAutoDetect=off")["prAutoDetect"]).toBe(false);
  });

  it("converts port fields to numbers in dashboard group", () => {
    const kv = "dashboardPort=3000\nterminalWsPort=3001\ndirectTerminalWsPort=3002";
    const result = convertKeyValueToJson(kv);
    expect(result["dashboard"]).toEqual({
      port: 3000,
      terminalWsPort: 3001,
      directTerminalWsPort: 3002,
    });
  });

  it("groups agentReport fields", () => {
    const kv = [
      "agentReportedState=addressing_reviews",
      "agentReportedAt=2026-04-21T12:35:05.200Z",
      "agentReportedNote=Fixed 2 test regressions",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["agentReport"]).toEqual({
      state: "addressing_reviews",
      at: "2026-04-21T12:35:05.200Z",
      note: "Fixed 2 test regressions",
    });
  });

  it("groups reportWatcher fields", () => {
    const kv = [
      "reportWatcherLastAuditedAt=2026-04-21T16:50:09.934Z",
      "reportWatcherActiveTrigger=stale_report",
      "reportWatcherTriggerActivatedAt=2026-04-21T13:12:39.670Z",
      "reportWatcherTriggerCount=133",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["reportWatcher"]).toEqual({
      lastAuditedAt: "2026-04-21T16:50:09.934Z",
      activeTrigger: "stale_report",
      triggerActivatedAt: "2026-04-21T13:12:39.670Z",
      triggerCount: 133,
    });
  });

  it("keeps detecting fields at top level (matching runtime behavior)", () => {
    const lifecycle = {
      version: 2,
      session: { kind: "worker", state: "working" },
    };
    const kv = [
      `statePayload=${JSON.stringify(lifecycle)}`,
      "lifecycleEvidence=review_pending",
      "detectingAttempts=3",
      "detectingStartedAt=2026-04-21T12:00:00.000Z",
      "detectingEvidenceHash=abc123",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    // Detecting fields stay at top level — the lifecycle manager reads them from
    // session.metadata["detectingAttempts"] etc., not from lifecycle.detecting
    expect(result["lifecycleEvidence"]).toBe("review_pending");
    expect(result["detectingAttempts"]).toBe("3");
    expect(result["detectingStartedAt"]).toBe("2026-04-21T12:00:00.000Z");
    expect(result["detectingEvidenceHash"]).toBe("abc123");
    // lifecycle object should NOT contain a detecting sub-object
    const resultLifecycle = result["lifecycle"] as Record<string, unknown>;
    expect(resultLifecycle).not.toHaveProperty("detecting");
  });

  it("parses runtimeHandle JSON string", () => {
    const handle = { id: "ao-1", runtimeName: "tmux", data: {} };
    const kv = `runtimeHandle=${JSON.stringify(handle)}`;
    const result = convertKeyValueToJson(kv);
    expect(result["runtimeHandle"]).toEqual(handle);
  });
});

describe("migrateStorage", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    configPath = join(aoBaseDir, "config.yaml");
    mkdirSync(aoBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("migrates a single project with one session", async () => {
    // Setup: hash dir with one worker session and worktree
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    mkdirSync(join(hashDir, "worktrees", "ao-1"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=working",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-1",
        "worktree=/home/user/.agent-orchestrator/aaaaaa000000-myproject/worktrees/ao-1",
      ].join("\n"),
    );

    // Setup: config with storageKey
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    storageKey: aaaaaa000000",
        "    defaultBranch: main",
        "",
      ].join("\n"),
    );

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(1);

    // Session file should exist in new location
    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    expect(existsSync(sessionPath)).toBe(true);

    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.project).toBe("myproject");
    expect(session.agent).toBe("claude-code");
    expect(session.worktree).toBe(join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1"));
    // status preserved for pre-lifecycle sessions (no statePayload)
    expect(session.status).toBe("working");

    // Old dir should be renamed to .migrated
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
    expect(existsSync(hashDir)).toBe(false);

    // Config should have storageKey stripped
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).not.toContain("storageKey");
  });

  it("writes orchestrator sessions to sessions/ alongside workers", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    // Orchestrator session
    writeFileSync(
      join(hashDir, "sessions", "ao-orchestrator-1"),
      [
        "project=myproject",
        "role=orchestrator",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
      ].join("\n"),
    );

    // Worker session
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    // Both orchestrator and worker are counted as sessions
    expect(result.sessions).toBe(2);

    // Orchestrator should be in sessions/ (not orchestrator.json)
    const orchSessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-orchestrator-1.json");
    expect(existsSync(orchSessionPath)).toBe(true);
    const orch = JSON.parse(readFileSync(orchSessionPath, "utf-8"));
    expect(orch.role).toBe("orchestrator");
  });

  it("merges multiple hash dirs for the same project", async () => {
    // Two hash dirs with different sessions for the same project
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-2"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T13:00:00.000Z\nbranch=b2\nworktree=/tmp/w2",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(2);

    // Both sessions should be in the new location
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-2.json"))).toBe(true);
  });

  it("handles duplicate session IDs across hash dirs", async () => {
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    // Same session ID, different timestamps — newer wins
    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T14:00:00.000Z\nbranch=b2\nworktree=/tmp/w2",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.sessions).toBe(1);
    expect(result.archives).toBeGreaterThanOrEqual(1);

    // The newer session should be kept
    const session = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );
    expect(session.createdAt).toBe("2026-04-21T14:00:00.000Z");
  });

  it("deletes empty hash directories", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-empty-project"), { recursive: true });

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.emptyDirsDeleted).toBe(1);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-empty-project"))).toBe(false);
  });

  it("dry run makes no changes", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b\nworktree=/tmp/w",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      dryRun: true,
      log: () => {},
    });

    // Nothing should have changed
    expect(existsSync(hashDir)).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects"))).toBe(false);
  });

  it("reports nothing to migrate when no hash dirs exist", async () => {
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(0);
    expect(result.sessions).toBe(0);
  });

  it("migrates archives with fixed filenames", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions", "archive"), { recursive: true });

    // Old archive with colon-containing timestamp
    writeFileSync(
      join(hashDir, "sessions", "archive", "ao-83_2026-04-20T14:30:52.000Z"),
      "project=myproject\ncreatedAt=2026-04-20T14:30:52.000Z\nbranch=b\nworktree=/tmp/w",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.archives).toBe(1);

    // Archive should exist in the new location with fixed filename
    const archiveDir = join(aoBaseDir, "projects", "myproject", "sessions", "archive");
    const archiveFiles = readdirSync(archiveDir);
    expect(archiveFiles.length).toBe(1);
    expect(archiveFiles[0]).toBe("ao-83_20260420T143052Z.json");
  });

  it("converts key=value format to JSON during migration", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    const lifecycle = JSON.stringify({
      version: 2,
      session: { kind: "worker", state: "working" },
    });

    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=working",
        "createdAt=2026-04-21T12:00:00.000Z",
        `statePayload=${lifecycle}`,
        "stateVersion=2",
        "prAutoDetect=on",
        "dashboardPort=3000",
        "agentReportedState=task_complete",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const session = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );

    expect(session.lifecycle).toEqual({
      version: 2,
      session: { kind: "worker", state: "working" },
    });
    expect(session.prAutoDetect).toBe(true);
    expect(session.dashboard).toEqual({ port: 3000 });
    expect(session.agentReport).toEqual({ state: "task_complete" });
    expect(session).not.toHaveProperty("status");
    expect(session).not.toHaveProperty("statePayload");
    expect(session).not.toHaveProperty("stateVersion");
  });

  it("migrated JSON without stored status derives status from lifecycle on read", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    const lifecycle = JSON.stringify({
      version: 2,
      session: { kind: "worker", state: "working", reason: "task_in_progress", startedAt: "2026-04-21T12:00:00.000Z", completedAt: null, terminatedAt: null, lastTransitionAt: "2026-04-21T12:00:00.000Z" },
      pr: { state: "open", reason: "review_pending", url: "https://github.com/test/repo/pull/1", lastObservedAt: "2026-04-21T12:30:00.000Z" },
      runtime: { handle: null, tmuxName: null },
    });

    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=review_pending",
        "createdAt=2026-04-21T12:00:00.000Z",
        `statePayload=${lifecycle}`,
        "stateVersion=2",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Verify status is NOT stored in the JSON file
    const rawJson = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );
    expect(rawJson).not.toHaveProperty("status");
    expect(rawJson.lifecycle).toBeDefined();

    // Verify readMetadata derives the correct status from lifecycle
    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");
    const meta = readMetadata(sessionsDir, "ao-1");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("review_pending");
  });

  it("migrates bare 12-hex hash directories", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    // Config with storageKey for lookup
    writeFileSync(configPath, [
      "projects:",
      "  myproject:",
      "    path: /home/user/myproject",
      "    storageKey: aaaaaa000000",
      "",
    ].join("\n"));

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(1);

    // Session should be under the correct project
    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    expect(existsSync(sessionPath)).toBe(true);

    // Old bare hash dir should be renamed to .migrated
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
    expect(existsSync(hashDir)).toBe(false);
  });

  it("preserves observability directories during migration", async () => {
    // Create an observability dir that matches the hash-name pattern
    const obsDir = join(aoBaseDir, "aaaaaa000000-observability");
    mkdirSync(obsDir, { recursive: true });
    writeFileSync(join(obsDir, "metrics.log"), "some observability data");

    // Also create a real project dir
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);

    // Observability dir must NOT be touched
    expect(existsSync(obsDir)).toBe(true);
    expect(readFileSync(join(obsDir, "metrics.log"), "utf-8")).toBe("some observability data");
  });

  it("is idempotent — re-running migration skips .migrated dirs", async () => {
    // First migration
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // After first migration: .migrated exists, projects/ exists
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);

    // Second migration — should be a no-op
    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.projects).toBe(0);
    expect(result.sessions).toBe(0);
    // Must NOT create .migrated.migrated
    expect(existsSync(`${hashDir}.migrated.migrated`)).toBe(false);
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
  });
});

describe("rollbackStorage", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    configPath = join(aoBaseDir, "config.yaml");
    mkdirSync(aoBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("restores .migrated directories and removes migrated projects", async () => {
    // Simulate post-migration state
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    // Config without storageKey
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    defaultBranch: main",
        "",
      ].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // .migrated should be restored
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated"))).toBe(false);

    // migrated project dir should be gone (no post-migration sessions)
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);

    // storageKey should be re-added to config in {hash}-{projectId} format
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("storageKey");
    expect(configContent).toContain("aaaaaa000000-myproject");
  });

  it("writes storageKey in original directory name format", async () => {
    mkdirSync(join(aoBaseDir, "a3b4c5d6e7f8-myapp.migrated"), { recursive: true });
    mkdirSync(join(aoBaseDir, "projects", "myapp"), { recursive: true });

    writeFileSync(configPath, [
      "projects:",
      "  myapp:",
      "    path: /home/user/myapp",
      "",
    ].join("\n"));

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    const configContent = readFileSync(configPath, "utf-8");
    // storageKey should be the full directory name, not just the hash
    expect(configContent).toContain("a3b4c5d6e7f8-myapp");
  });

  it("preserves post-migration sessions during rollback", async () => {
    // Simulate migrated dir with original session
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    // Migrated sessions (from migration) — ao-1 came from .migrated, ao-50 was created after
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-50.json"),
      '{"project":"myproject","status":"working"}',
    );

    // A DIFFERENT project that was NOT migrated (created post-migration)
    mkdirSync(join(aoBaseDir, "projects", "new-project", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "new-project", "sessions", "ao-99.json"),
      '{"project":"new-project","status":"working"}',
    );

    writeFileSync(configPath, [
      "projects:",
      "  myproject:",
      "    path: /home/user/myproject",
      "  new-project:",
      "    path: /home/user/new-project",
      "",
    ].join("\n"));

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    // myproject has ao-50 which was created post-migration — dir should be PRESERVED
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-50.json"))).toBe(true);
    expect(logs.some((l) => l.includes("1 session(s) created after migration"))).toBe(true);

    // Non-migrated project dir must be preserved
    expect(existsSync(join(aoBaseDir, "projects", "new-project", "sessions", "ao-99.json"))).toBe(true);

    // projects/ dir should still exist (has remaining content)
    expect(existsSync(join(aoBaseDir, "projects"))).toBe(true);
  });

  it("deletes migrated project dir when no post-migration sessions exist", async () => {
    // Simulate migrated dir with original session
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    // Only the migrated session in the project dir — no new sessions
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    writeFileSync(configPath, [
      "projects:",
      "  myproject:",
      "    path: /home/user/myproject",
      "",
    ].join("\n"));

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // No post-migration sessions — safe to delete
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);
  });

  it("moves worktrees back to restored hash dir before deleting project dir", async () => {
    // Simulate post-migration state: worktree was moved to projects/
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "worktrees"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    mkdirSync(join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );
    // Simulate a file inside the worktree
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1", "README.md"),
      "# test",
    );

    writeFileSync(configPath, [
      "projects:",
      "  myproject:",
      "    path: /home/user/myproject",
      "",
    ].join("\n"));

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // Worktree should be moved back to restored hash dir
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject", "worktrees", "ao-1"))).toBe(true);
    expect(readFileSync(join(aoBaseDir, "aaaaaa000000-myproject", "worktrees", "ao-1", "README.md"), "utf-8")).toBe("# test");

    // Project dir should be deleted
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);
  });

  it("does nothing when no .migrated directories exist", async () => {
    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    expect(logs.some((l) => l.includes("Nothing to rollback"))).toBe(true);
  });

  it("dry run reports actions without modifying files", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      dryRun: true,
      log: (msg) => logs.push(msg),
    });

    expect(logs.some((l) => l.includes("DRY RUN"))).toBe(true);
    // .migrated dir should still exist (not renamed)
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated"))).toBe(true);
    // migrated project dir should still exist (not deleted)
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(true);
  });
});

describe("migration edge cases", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    mkdirSync(aoBaseDir, { recursive: true });
    configPath = join(testDir, "config.yaml");
    writeFileSync(configPath, "projects: {}\n");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("blocks migration when active sessions detected (or proceeds when none)", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(join(hashDir, "sessions", "ao-1"), "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1");

    try {
      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        // force: false is default
        log: () => {},
      });
      // No active sessions (CI) → migration proceeds
      expect(result.sessions).toBe(1);
    } catch (err) {
      // Active sessions detected → throws with actionable message
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("active AO tmux session");
      expect((err as Error).message).toContain("--force");
    }
  });

  it("migrates worktree directories to new layout", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    mkdirSync(join(hashDir, "worktrees", "ao-1"), { recursive: true });
    writeFileSync(join(hashDir, "worktrees", "ao-1", "file.txt"), "test");
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.worktrees).toBe(1);
    // Worktree should be moved to new location
    const newWorktree = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
    expect(existsSync(newWorktree)).toBe(true);
    expect(readFileSync(join(newWorktree, "file.txt"), "utf-8")).toBe("test");
  });

  it("preserves status for pre-lifecycle sessions during migration", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Pre-lifecycle session should retain status in migrated JSON
    const session = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );
    expect(session.status).toBe("working");
    expect(session).not.toHaveProperty("lifecycle");

    // readMetadata should use the stored status
    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");
    const meta = readMetadata(sessionsDir, "ao-1");
    expect(meta!.status).toBe("working");
  });

  it("archive filenames are unique even for same-millisecond duplicates", async () => {
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    // Same session ID in both hash dirs
    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T10:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // One session in sessions/, one archived
    const archiveDir = join(aoBaseDir, "projects", "myproject", "sessions", "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archives = readdirSync(archiveDir).filter((f) => f.startsWith("ao-1_"));
    expect(archives).toHaveLength(1);
    // Archive filename should include counter suffix
    expect(archives[0]).toMatch(/-\d+\.json$/);
  });

  it("moves stray worktrees from nested ~/.worktrees/{projectId}/{sessionId}/ layout", async () => {
    // Setup: hash dir with session (no worktree in hash dir — it's in ~/.worktrees/)
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    // Setup: stray worktree at ~/.worktrees/myproject/ao-1/ (default workspace plugin layout)
    const strayDir = join(homedir(), ".worktrees", "myproject", "ao-1");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, "marker.txt"), "stray-test");

    try {
      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        force: true,
        log: () => {},
      });

      expect(result.strayWorktreesMoved).toBe(1);

      // Worktree should be in new location
      const newWorktree = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
      expect(existsSync(newWorktree)).toBe(true);
      expect(readFileSync(join(newWorktree, "marker.txt"), "utf-8")).toBe("stray-test");

      // Original should be cleaned up
      expect(existsSync(strayDir)).toBe(false);
    } finally {
      // Cleanup stray dir if test failed before migration moved it
      const parentDir = join(homedir(), ".worktrees", "myproject");
      if (existsSync(parentDir)) {
        rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps original worktree path when worktree directory was not moved", async () => {
    // Session references a worktree at an external path (e.g. ~/.worktrees/myproject/ao-1)
    // but no worktree directory exists in the hash dir to be moved
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/external-worktree/ao-1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    // Path should NOT be rewritten since no worktree was moved to the new location
    expect(session.worktree).toBe("/tmp/external-worktree/ao-1");
  });

  it("writes and removes .migration-in-progress marker file", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const markerPath = join(aoBaseDir, ".migration-in-progress");

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Marker should be removed after successful migration
    expect(existsSync(markerPath)).toBe(false);
    // Migration should have completed
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(true);
  });

  it("detects interrupted migration on re-run", async () => {
    const markerPath = join(aoBaseDir, ".migration-in-progress");
    // Simulate interrupted migration: marker exists, partial state
    writeFileSync(markerPath, "2026-04-21T12:00:00.000Z");
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const logs: string[] = [];
    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    // Should warn about interrupted migration
    expect(logs.some((m) => m.includes("interrupted"))).toBe(true);
    // Should still complete successfully
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(true);
  });

  it("does not write marker file in dry-run mode", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      dryRun: true,
      log: () => {},
    });

    expect(existsSync(join(aoBaseDir, ".migration-in-progress"))).toBe(false);
  });

  it("handles corrupt session metadata during migration without crashing", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    // Good session
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    // Corrupt session (binary garbage)
    writeFileSync(join(hashDir, "sessions", "ao-2"), Buffer.from([0x00, 0xff, 0xfe]));
    // Empty session
    writeFileSync(join(hashDir, "sessions", "ao-3"), "");

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Good session should be migrated
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(true);
    // Migration should not crash
    expect(result.projects).toBe(1);
  });
});

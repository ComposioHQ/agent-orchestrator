/**
 * Tests for lib/config-bootstrap.ts — the YAML-mutation helpers that add a
 * new orchestrator entry and save per-session agent overrides. Both were
 * previously inlined in start.ts and untested at the unit level; they have
 * real branching (global vs local config, prefix collision avoidance).
 *
 * autoCreateConfig / addProjectToConfig are exercised end-to-end by
 * start.test.ts; no need to duplicate that here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as yamlParse } from "yaml";
import {
  addDuplicateProjectToConfig,
  isCanonicalGlobalConfigPath,
  saveAgentOverride,
} from "../../src/lib/config-bootstrap.js";
import { getGlobalConfigPath, type OrchestratorConfig } from "@aoagents/ao-core";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ao-config-bootstrap-"));
  configPath = join(tmp, "agent-orchestrator.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(yaml: string): OrchestratorConfig {
  writeFileSync(configPath, yaml);
  // We only need the shape that these helpers consume: configPath + projects.
  return {
    configPath,
    projects: yamlParse(yaml).projects,
  } as unknown as OrchestratorConfig;
}

describe("isCanonicalGlobalConfigPath", () => {
  it("returns true only for the canonical global config path", () => {
    expect(isCanonicalGlobalConfigPath(getGlobalConfigPath())).toBe(true);
    expect(isCanonicalGlobalConfigPath("/tmp/some-other-config.yaml")).toBe(false);
    expect(isCanonicalGlobalConfigPath(undefined)).toBe(false);
  });
});

describe("addDuplicateProjectToConfig", () => {
  it("appends a sibling project with a unique id + session prefix", () => {
    const config = writeConfig(
      `port: 3000\nprojects:\n  foo:\n    name: foo\n    path: /repos/foo\n    defaultBranch: main\n    sessionPrefix: foo\n`,
    );
    const newId = addDuplicateProjectToConfig(config, "foo");

    expect(newId).toMatch(/^foo-[a-z0-9]{4}$/);

    const written = yamlParse(readFileSync(configPath, "utf-8"));
    expect(Object.keys(written.projects)).toContain(newId);
    // The new entry should carry over siblings' fields but with a fresh prefix
    expect(written.projects[newId].path).toBe("/repos/foo");
    expect(written.projects[newId].sessionPrefix).not.toBe("foo");
  });

  it("avoids prefix collisions when the random prefix happens to match", () => {
    const config = writeConfig(
      `port: 3000\nprojects:\n  foo:\n    name: foo\n    path: /repos/foo\n    sessionPrefix: foo\n    defaultBranch: main\n  bar:\n    name: bar\n    path: /repos/bar\n    sessionPrefix: bar\n    defaultBranch: main\n`,
    );
    const newId = addDuplicateProjectToConfig(config, "foo");
    const written = yamlParse(readFileSync(configPath, "utf-8"));
    const allPrefixes = Object.values(written.projects).map(
      (p: unknown) => (p as { sessionPrefix?: string }).sessionPrefix,
    );
    // Prefix must be unique across all projects
    expect(new Set(allPrefixes).size).toBe(allPrefixes.length);
    expect(written.projects[newId]).toBeDefined();
  });
});

describe("saveAgentOverride", () => {
  it("writes orchestrator + worker agent into the project entry of a local YAML", () => {
    const config = writeConfig(
      `port: 3000\nprojects:\n  foo:\n    name: foo\n    path: ${tmp}\n    defaultBranch: main\n`,
    );
    saveAgentOverride(config.configPath, "foo", tmp, {
      orchestratorAgent: "claude-code",
      workerAgent: "codex",
    });

    const written = yamlParse(readFileSync(configPath, "utf-8"));
    expect(written.projects.foo.orchestrator.agent).toBe("claude-code");
    expect(written.projects.foo.worker.agent).toBe("codex");
  });

  it("throws a clear error when the project is absent from the on-disk YAML", () => {
    const config = writeConfig(
      `port: 3000\nprojects:\n  foo:\n    name: foo\n    path: ${tmp}\n    defaultBranch: main\n`,
    );
    expect(() =>
      saveAgentOverride(config.configPath, "missing", tmp, {
        orchestratorAgent: "claude-code",
        workerAgent: "codex",
      }),
    ).toThrow(/Project "missing" not found/);
  });

  it("preserves existing orchestrator/worker subfields when merging", () => {
    const config = writeConfig(
      `port: 3000\nprojects:\n  foo:\n    name: foo\n    path: ${tmp}\n    defaultBranch: main\n    orchestrator:\n      agent: old\n      extra: keep-me\n`,
    );
    saveAgentOverride(config.configPath, "foo", tmp, {
      orchestratorAgent: "claude-code",
      workerAgent: "codex",
    });

    const written = yamlParse(readFileSync(configPath, "utf-8"));
    expect(written.projects.foo.orchestrator.agent).toBe("claude-code");
    expect(written.projects.foo.orchestrator.extra).toBe("keep-me");
  });
});

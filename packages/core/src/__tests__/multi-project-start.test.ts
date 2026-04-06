/**
 * Tests for resolveMultiProjectStart — core multi-project registration logic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { resolveMultiProjectStart, registerNewProject, validateAndCommitRegistration } from "../multi-project-start.js";
import { loadGlobalConfig, scaffoldGlobalConfig, findGlobalConfigPath } from "../global-config.js";
import { createGlobalConfigEnv, setupGlobalConfig } from "./helpers.js";

const env = createGlobalConfigEnv("ao-mps");
let testDir: string;

beforeEach(() => {
  testDir = env.setup();
});

afterEach(() => env.teardown());

describe("resolveMultiProjectStart", () => {
  it("returns null when no global config exists", () => {
    const result = resolveMultiProjectStart(testDir);
    expect(result).toBeNull();
  });

  it("returns null when CWD has no local config and is not registered", () => {
    setupGlobalConfig({});
    const unregisteredDir = join(testDir, "unregistered");
    mkdirSync(unregisteredDir, { recursive: true });
    const result = resolveMultiProjectStart(unregisteredDir);
    expect(result).toBeNull();
  });

  it("registers a new project with local config", () => {
    setupGlobalConfig({});
    const projectDir = join(testDir, "my-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/my-app", defaultBranch: "main", agent: "claude-code" }),
    );

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBeTruthy();
    expect(result!.config.projects[result!.projectId]).toBeDefined();
    expect(result!.config.projects[result!.projectId].repo).toBe("org/my-app");

    // Global config should have the project registered
    const gc = loadGlobalConfig();
    expect(gc!.projects[result!.projectId]).toBeDefined();

    // Messages should include registration info
    expect(result!.messages.some((m) => m.text.includes("Registered"))).toBe(true);
  });

  it("returns config for already-registered project with local config", () => {
    const projectDir = join(testDir, "existing-app");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/existing", defaultBranch: "main", agent: "aider" }),
    );

    setupGlobalConfig({ ea: { name: "Existing App", path: projectDir } });

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("ea");
    expect(result!.config.projects["ea"].agent).toBe("aider");
  });

  it("handles ID collision with auto-suffix", () => {
    // Pre-register a project with ID "backend" pointing to a different path.
    // A new project whose basename is also "backend" collides on ID and should
    // get auto-suffixed to "backend2". The session prefixes differ because
    // applyProjectDefaults derives them from basename(path), which differ here.
    const existingDir = join(testDir, "some-other-backend");
    const newDir = join(testDir, "backend");
    mkdirSync(existingDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(newDir, "agent-orchestrator.yaml"), stringifyYaml({ repo: "org/backend", defaultBranch: "main" }));

    // Pre-occupy the "backend" ID with a different path.
    setupGlobalConfig({ backend: { name: "Existing", path: existingDir } });

    const result = resolveMultiProjectStart(newDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).not.toBe("backend");
    expect(result!.projectId).toBe("backend2");
    expect(result!.messages.some((m) => m.text.includes("taken"))).toBe(true);
  });

  it("finds local config from subdirectory", () => {
    const projectDir = join(testDir, "sub-test");
    const subDir = join(projectDir, "src", "lib");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/sub-test", defaultBranch: "main" }),
    );

    setupGlobalConfig({});

    const result = resolveMultiProjectStart(subDir);
    expect(result).not.toBeNull();
    // Should register with the project root, not the subdirectory
    const project = result!.config.projects[result!.projectId];
    expect(project.path).toBe(projectDir);
  });

  it("registerNewProject is pure — does not write to disk", () => {
    const projectDir = join(testDir, "pure-test");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "agent-orchestrator.yaml"),
      stringifyYaml({ repo: "org/pure-test", defaultBranch: "main", agent: "aider" }),
    );

    const globalConfig = scaffoldGlobalConfig();
    const reg = registerNewProject(globalConfig, projectDir);

    expect(reg.projectId).toBeTruthy();

    // Must NOT have persisted the updated global config
    const savedGc = loadGlobalConfig();
    expect(Object.keys(savedGc?.projects ?? {})).toHaveLength(0);
  });

  it("registerNewProject throws when explicitId collides with a different path", () => {
    const dir1 = join(testDir, "alpha");
    const dir2 = join(testDir, "beta");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const gc2 = registerNewProject(scaffoldGlobalConfig(), dir1, { explicitId: "my-id" }).updatedGlobalConfig;
    expect(() => registerNewProject(gc2, dir2, { explicitId: "my-id" })).toThrow(/already in use/);
  });

  it("validateAndCommitRegistration surfaces warning when local config is invalid", () => {
    const projectDir = join(testDir, "bad-config");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "agent-orchestrator.yaml"), "!!invalid: [unclosed");

    const gc = setupGlobalConfig({});
    const reg = registerNewProject(gc, projectDir);
    const warnings: string[] = [];
    validateAndCommitRegistration(reg, findGlobalConfigPath(), warnings);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("local config") || w.includes("bad-config"))).toBe(true);
  });

  it("warns (non-fatal) when local config is invalid on already-registered project", () => {
    const projectDir = join(testDir, "sync-fail-proj");
    mkdirSync(projectDir, { recursive: true });
    setupGlobalConfig({ sf: { name: "SyncFail", path: projectDir } });

    writeFileSync(join(projectDir, "agent-orchestrator.yaml"), "!!invalid: [unclosed");

    const result = resolveMultiProjectStart(projectDir);
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("sf");
    // Invalid local config causes a warning from buildEffectiveConfig
    expect(result!.messages.some((m) => m.level === "warn")).toBe(true);
  });
});

describe("validateAndCommitRegistration", () => {
  it("commits registration to global config", () => {
    const projectDir = join(testDir, "write-order-test");
    mkdirSync(projectDir, { recursive: true });

    const gc = setupGlobalConfig({});
    const reg = registerNewProject(gc, projectDir, {});
    validateAndCommitRegistration(reg, findGlobalConfigPath());

    const updatedGc = loadGlobalConfig();
    expect(updatedGc!.projects[reg.projectId]).toBeDefined();
  });

  it("throws on validation failure and does not commit", () => {
    // Use two projects with different basenames that derive the same session
    // prefix ("int") — this collision is not auto-resolved and must fail
    // validateProjectUniqueness so we can verify the validate-first, write-after
    // guarantee.  (Same-basename collisions are auto-disambiguated by
    // applyProjectDefaults and must NOT be used here.)
    const integratorDir = join(testDir, "integrator");
    const internationalDir = join(testDir, "international");
    mkdirSync(integratorDir, { recursive: true });
    mkdirSync(internationalDir, { recursive: true });

    const gc = setupGlobalConfig({});

    // Register "integrator" first — gets prefix "int".
    const reg1 = registerNewProject(gc, integratorDir, { explicitId: "proj-a" });
    validateAndCommitRegistration(reg1, findGlobalConfigPath());

    // Register "international" — also derives prefix "int" → collision.
    const gc2 = loadGlobalConfig()!;
    const reg2 = registerNewProject(gc2, internationalDir, { explicitId: "proj-b" });

    expect(() => validateAndCommitRegistration(reg2, findGlobalConfigPath())).toThrow();

    // proj-b must NOT be committed
    expect(loadGlobalConfig()!.projects["proj-b"]).toBeUndefined();
    // proj-a's registration must still be intact
    expect(loadGlobalConfig()!.projects["proj-a"]).toBeDefined();
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadGlobalConfig } from "@composio/ao-core";
import { migrateLegacyConfigForPortfolioRegistration } from "../legacy-config-migration";

const createdDirs: string[] = [];
const originalGlobalConfig = process.env.AO_GLOBAL_CONFIG;

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.AO_GLOBAL_CONFIG = originalGlobalConfig;
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("migrateLegacyConfigForPortfolioRegistration", () => {
  it("rewrites a matching old-format config and syncs it into global config", () => {
    const globalDir = makeTempDir("ao-global");
    const repoDir = makeTempDir("ao-repo");
    const globalConfigPath = join(globalDir, "config.yaml");
    process.env.AO_GLOBAL_CONFIG = globalConfigPath;

    const configPath = join(repoDir, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      [
        "port: 3001",
        "projects:",
        "  ai-readiness:",
        "    name: ai-readiness",
        `    path: ${repoDir}`,
        "    repo: ashish921998/ai-readiness",
        "    defaultBranch: main",
        "    sessionPrefix: ar",
        "    agent: claude-code",
      ].join("\n"),
      "utf-8",
    );

    const result = migrateLegacyConfigForPortfolioRegistration(repoDir, configPath);

    expect(result).toEqual({ migrated: true, configProjectKey: "ai-readiness" });

    const rewritten = readFileSync(configPath, "utf-8");
    expect(rewritten).toContain("repo: ashish921998/ai-readiness");
    expect(rewritten).toContain("agent: claude-code");
    expect(rewritten).not.toContain("projects:");
    expect(rewritten).not.toContain("path:");

    const globalConfig = loadGlobalConfig(globalConfigPath);
    expect(globalConfig?.projects["ai-readiness"]).toMatchObject({
      name: "ai-readiness",
      path: repoDir,
      repo: "ashish921998/ai-readiness",
      defaultBranch: "main",
      agent: "claude-code",
      sessionPrefix: "ar",
    });
  });

  it("rejects old-format configs with multiple entries for the same repo path", () => {
    const globalDir = makeTempDir("ao-global");
    const repoDir = makeTempDir("ao-repo");
    process.env.AO_GLOBAL_CONFIG = join(globalDir, "config.yaml");

    const configPath = join(repoDir, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      [
        "projects:",
        "  ai-readiness:",
        `    path: ${repoDir}`,
        "    repo: ashish921998/ai-readiness",
        "  ai-readiness-rv7k:",
        `    path: ${repoDir}`,
        "    repo: ashish921998/ai-readiness",
      ].join("\n"),
      "utf-8",
    );

    expect(() =>
      migrateLegacyConfigForPortfolioRegistration(repoDir, configPath),
    ).toThrow(/multiple project entries for the same path/i);
  });
});

#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const agentsRoot = join(repoRoot, "agents");

function fail(message) {
  throw new Error(message);
}

async function exists(pathValue) {
  try {
    await stat(pathValue);
    return true;
  } catch {
    return false;
  }
}

async function readJson(pathValue) {
  const raw = await readFile(pathValue, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in ${relative(repoRoot, pathValue)}: ${message}`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

async function listAgentDirs() {
  const entries = await readdir(agentsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => join(agentsRoot, entry.name));
}

async function validateAgent(agentDir) {
  const manifestPath = join(agentDir, "agent.json");
  if (!(await exists(manifestPath))) {
    fail(`Missing agent manifest: ${relative(repoRoot, manifestPath)}`);
  }

  const manifest = await readJson(manifestPath);
  assertString(manifest.id, `${relative(repoRoot, manifestPath)}: id`);
  assertString(manifest.name, `${relative(repoRoot, manifestPath)}: name`);
  assertString(manifest.description, `${relative(repoRoot, manifestPath)}: description`);
  assertString(manifest.systemPrompt, `${relative(repoRoot, manifestPath)}: systemPrompt`);

  const systemPromptPath = resolve(agentDir, manifest.systemPrompt);
  if (!(await exists(systemPromptPath))) {
    fail(
      `${relative(repoRoot, manifestPath)} references missing system prompt ${relative(repoRoot, systemPromptPath)}`,
    );
  }

  if (typeof manifest.slots !== "object" || manifest.slots === null) {
    fail(`${relative(repoRoot, manifestPath)}: slots must be an object`);
  }

  for (const [slotName, slotRef] of Object.entries(manifest.slots)) {
    if (typeof slotRef !== "object" || slotRef === null) {
      fail(`${relative(repoRoot, manifestPath)}: slots.${slotName} must be an object`);
    }

    const slotPathValue = slotRef.path;
    const slotConfigId = slotRef.config;
    assertString(slotPathValue, `${relative(repoRoot, manifestPath)}: slots.${slotName}.path`);
    assertString(slotConfigId, `${relative(repoRoot, manifestPath)}: slots.${slotName}.config`);

    const slotDir = resolve(agentDir, slotPathValue);
    const slotManifestPath = join(slotDir, "slot.json");
    if (!(await exists(slotManifestPath))) {
      fail(`Missing slot manifest for ${slotName}: ${relative(repoRoot, slotManifestPath)}`);
    }

    const slotManifest = await readJson(slotManifestPath);
    assertString(slotManifest.slot, `${relative(repoRoot, slotManifestPath)}: slot`);
    assertString(slotManifest.description, `${relative(repoRoot, slotManifestPath)}: description`);
    assertString(slotManifest.configDir, `${relative(repoRoot, slotManifestPath)}: configDir`);
    assertString(slotManifest.sourcesDir, `${relative(repoRoot, slotManifestPath)}: sourcesDir`);

    const configDir = resolve(slotDir, slotManifest.configDir);
    const configPath = join(configDir, `${slotConfigId}.json`);
    if (!(await exists(configPath))) {
      fail(`Missing slot config ${slotConfigId} for ${slotName}: ${relative(repoRoot, configPath)}`);
    }

    const slotConfig = await readJson(configPath);
    assertString(slotConfig.id, `${relative(repoRoot, configPath)}: id`);
    assertString(slotConfig.name, `${relative(repoRoot, configPath)}: name`);
    assertString(slotConfig.promptSource, `${relative(repoRoot, configPath)}: promptSource`);
    assertString(slotConfig.researchMode, `${relative(repoRoot, configPath)}: researchMode`);
    assertString(slotConfig.noveltyBar, `${relative(repoRoot, configPath)}: noveltyBar`);
    assertString(slotConfig.outputMode, `${relative(repoRoot, configPath)}: outputMode`);

    if (!Array.isArray(slotConfig.sourceTypes) || slotConfig.sourceTypes.length === 0) {
      fail(`${relative(repoRoot, configPath)}: sourceTypes must be a non-empty array`);
    }

    if (!Array.isArray(slotConfig.scoringAxes) || slotConfig.scoringAxes.length === 0) {
      fail(`${relative(repoRoot, configPath)}: scoringAxes must be a non-empty array`);
    }

    const promptSourcePath = resolve(configDir, slotConfig.promptSource);
    if (!(await exists(promptSourcePath))) {
      fail(
        `${relative(repoRoot, configPath)} references missing prompt source ${relative(repoRoot, promptSourcePath)}`,
      );
    }
  }
}

async function main() {
  if (!(await exists(agentsRoot))) {
    fail(`Missing agents directory: ${relative(repoRoot, agentsRoot)}`);
  }

  const agentDirs = await listAgentDirs();
  if (agentDirs.length === 0) {
    fail("No repo-local agents found.");
  }

  for (const agentDir of agentDirs) {
    await validateAgent(agentDir);
  }

  console.log(`Validated ${agentDirs.length} repo-local agent definition(s).`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

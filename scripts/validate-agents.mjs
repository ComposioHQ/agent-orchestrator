#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const agentsRoot = join(repoRoot, "agents");
const fleetsRoot = join(repoRoot, "fleets");

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

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
}

function assertNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
}

function assertStringArray(value, label, { requireNonEmpty = false } = {}) {
  assertArray(value, label);
  if (requireNonEmpty && value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  for (const [index, item] of value.entries()) {
    assertString(item, `${label}[${index}]`);
  }
}

async function listRecordDirs(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => join(rootDir, entry.name));
}

async function listAgentDirs() {
  return listRecordDirs(agentsRoot);
}

async function listFleetDirs() {
  return listRecordDirs(fleetsRoot);
}

async function loadAgentRecord(agentDir) {
  const manifestPath = join(agentDir, "agent.json");
  if (!(await exists(manifestPath))) {
    fail(`Missing agent manifest: ${relative(repoRoot, manifestPath)}`);
  }

  const manifest = await readJson(manifestPath);
  return { agentDir, manifest, manifestPath };
}

async function loadFleetRecord(fleetDir) {
  const manifestPath = join(fleetDir, "fleet.json");
  if (!(await exists(manifestPath))) {
    fail(`Missing fleet manifest: ${relative(repoRoot, manifestPath)}`);
  }

  const manifest = await readJson(manifestPath);
  return { fleetDir, manifest, manifestPath };
}

async function loadSlotRecord(agentDir, slotName, slotRef) {
  const slotDir = resolve(agentDir, slotRef.path);
  const slotManifestPath = join(slotDir, "slot.json");
  if (!(await exists(slotManifestPath))) {
    fail(`Missing slot manifest for ${slotName}: ${relative(repoRoot, slotManifestPath)}`);
  }

  const slotManifest = await readJson(slotManifestPath);
  assertString(slotManifest.slot, `${relative(repoRoot, slotManifestPath)}: slot`);
  assertString(slotManifest.description, `${relative(repoRoot, slotManifestPath)}: description`);
  assertString(slotManifest.configDir, `${relative(repoRoot, slotManifestPath)}: configDir`);
  assertString(slotManifest.sourcesDir, `${relative(repoRoot, slotManifestPath)}: sourcesDir`);
  assertNonEmptyArray(slotManifest.fields, `${relative(repoRoot, slotManifestPath)}: fields`);
  for (const [index, field] of slotManifest.fields.entries()) {
    assertObject(field, `${relative(repoRoot, slotManifestPath)}: fields[${index}]`);
    assertString(field.name, `${relative(repoRoot, slotManifestPath)}: fields[${index}].name`);
    assertString(field.type, `${relative(repoRoot, slotManifestPath)}: fields[${index}].type`);
    if (typeof field.required !== "boolean") {
      fail(`${relative(repoRoot, slotManifestPath)}: fields[${index}].required must be a boolean`);
    }
    assertString(field.description, `${relative(repoRoot, slotManifestPath)}: fields[${index}].description`);
  }

  const configDir = resolve(slotDir, slotManifest.configDir);
  const sourcesDir = resolve(slotDir, slotManifest.sourcesDir);

  return { slotDir, slotManifest, slotManifestPath, configDir, sourcesDir };
}

async function assertPromptSourceExists(configPath, configDir, promptSource) {
  const promptSourcePath = resolve(configDir, promptSource);
  if (!(await exists(promptSourcePath))) {
    fail(
      `${relative(repoRoot, configPath)} references missing prompt source ${relative(repoRoot, promptSourcePath)}`,
    );
  }
}

async function validateAgentSlotConfigReference(reference, label, agentRecords, configPath) {
  const sourceAgent = agentRecords.get(reference.agentId);
  if (!sourceAgent) {
    fail(
      `${relative(repoRoot, configPath)} references unknown source agent ${reference.agentId}`,
    );
  }

  const sourceSlotRef = sourceAgent.manifest.slots?.[reference.slot];
  assertObject(sourceSlotRef, `${relative(repoRoot, sourceAgent.manifestPath)}: slots.${reference.slot}`);

  const sourceSlotRecord = await loadSlotRecord(sourceAgent.agentDir, reference.slot, sourceSlotRef);
  const sourceConfigPath = join(sourceSlotRecord.configDir, `${reference.config}.json`);
  if (!(await exists(sourceConfigPath))) {
    fail(
      `${label} references missing source config ${relative(repoRoot, sourceConfigPath)}`,
    );
  }
}

const fieldTypeValidators = {
  async string(value, label, _context, required) {
    if (value === undefined) {
      if (required) {
        fail(`${label} is required`);
      }
      return;
    }

    assertString(value, label);
  },

  async "string[]"(value, label, _context, required) {
    if (value === undefined) {
      if (required) {
        fail(`${label} is required`);
      }
      return;
    }

    assertStringArray(value, label, { requireNonEmpty: required });
  },

  async "markdown-path"(value, label, context, required) {
    if (value === undefined) {
      if (required) {
        fail(`${label} is required`);
      }
      return;
    }

    assertString(value, label);
    await assertPromptSourceExists(context.configPath, context.configDir, value);
  },

  async "agent-slot-config-ref"(value, label, context, required) {
    if (value === undefined) {
      if (required) {
        fail(`${label} is required`);
      }
      return;
    }

    assertObject(value, label);
    assertString(value.agentId, `${label}.agentId`);
    assertString(value.slot, `${label}.slot`);
    assertString(value.config, `${label}.config`);
    await validateAgentSlotConfigReference(value, label, context.agentRecords, context.configPath);
  },
};

async function validateSlotConfig(slotRecord, slotConfig, configPath, agentRecords) {
  assertObject(slotConfig, `${relative(repoRoot, configPath)}`);
  assertString(slotConfig.id, `${relative(repoRoot, configPath)}: id`);
  assertString(slotConfig.name, `${relative(repoRoot, configPath)}: name`);

  const fieldNames = new Set();
  for (const [index, field] of slotRecord.slotManifest.fields.entries()) {
    if (fieldNames.has(field.name)) {
      fail(
        `${relative(repoRoot, slotRecord.slotManifestPath)}: duplicate field definition ${field.name} at index ${index}`,
      );
    }
    fieldNames.add(field.name);

    const validator = fieldTypeValidators[field.type];
    if (!validator) {
      fail(
        `Unsupported field type ${field.type} in ${relative(repoRoot, slotRecord.slotManifestPath)}`,
      );
    }

    await validator(
      slotConfig[field.name],
      `${relative(repoRoot, configPath)}: ${field.name}`,
      { agentRecords, configDir: slotRecord.configDir, configPath },
      field.required,
    );
  }
}

async function validateAgent(agentRecord, agentRecords) {
  const { agentDir, manifest, manifestPath } = agentRecord;
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
    assertObject(slotRef, `${relative(repoRoot, manifestPath)}: slots.${slotName}`);

    const slotPathValue = slotRef.path;
    const slotConfigId = slotRef.config;
    assertString(slotPathValue, `${relative(repoRoot, manifestPath)}: slots.${slotName}.path`);
    assertString(slotConfigId, `${relative(repoRoot, manifestPath)}: slots.${slotName}.config`);

    const slotRecord = await loadSlotRecord(agentDir, slotName, slotRef);
    const { configDir, slotManifest } = slotRecord;
    const configPath = join(configDir, `${slotConfigId}.json`);
    if (!(await exists(configPath))) {
      fail(`Missing slot config ${slotConfigId} for ${slotName}: ${relative(repoRoot, configPath)}`);
    }

    const slotConfig = await readJson(configPath);
    await validateSlotConfig(slotRecord, slotConfig, configPath, agentRecords);
  }
}

async function validateFleet(fleetRecord) {
  const { manifest, manifestPath } = fleetRecord;
  assertString(manifest.id, `${relative(repoRoot, manifestPath)}: id`);
  assertString(manifest.name, `${relative(repoRoot, manifestPath)}: name`);
  assertString(manifest.description, `${relative(repoRoot, manifestPath)}: description`);
  if (manifest.goal !== undefined) {
    assertString(manifest.goal, `${relative(repoRoot, manifestPath)}: goal`);
  }
  assertNonEmptyArray(manifest.agents, `${relative(repoRoot, manifestPath)}: agents`);

  const fleetAgentIds = new Set();
  for (const [index, fleetAgent] of manifest.agents.entries()) {
    const label = `${relative(repoRoot, manifestPath)}: agents[${index}]`;
    assertObject(fleetAgent, label);
    assertString(fleetAgent.agentId, `${label}.agentId`);
    assertString(fleetAgent.stage, `${label}.stage`);
    if (fleetAgent.outputs !== undefined) {
      assertStringArray(fleetAgent.outputs, `${label}.outputs`, { requireNonEmpty: false });
    }
    if (fleetAgent.dependsOn !== undefined) {
      assertStringArray(fleetAgent.dependsOn, `${label}.dependsOn`, { requireNonEmpty: false });
    }

    if (fleetAgentIds.has(fleetAgent.agentId)) {
      fail(`${label}.agentId duplicates ${fleetAgent.agentId} in the same fleet manifest`);
    }
    fleetAgentIds.add(fleetAgent.agentId);
  }

  for (const [index, fleetAgent] of manifest.agents.entries()) {
    const label = `${relative(repoRoot, manifestPath)}: agents[${index}]`;
    for (const dependency of fleetAgent.dependsOn ?? []) {
      if (dependency === fleetAgent.agentId) {
        fail(`${label}.dependsOn cannot reference ${fleetAgent.agentId} itself`);
      }
      if (!fleetAgentIds.has(dependency)) {
        fail(`${label}.dependsOn references unknown fleet agent ${dependency}`);
      }
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

  const agentRecords = new Map();
  for (const agentDir of agentDirs) {
    const agentRecord = await loadAgentRecord(agentDir);
    if (agentRecords.has(agentRecord.manifest.id)) {
      fail(`Duplicate agent id: ${agentRecord.manifest.id}`);
    }
    agentRecords.set(agentRecord.manifest.id, agentRecord);
  }

  for (const agentRecord of agentRecords.values()) {
    await validateAgent(agentRecord, agentRecords);
  }

  let fleetCount = 0;
  if (await exists(fleetsRoot)) {
    const fleetDirs = await listFleetDirs();
    const fleetRecords = [];

    for (const fleetDir of fleetDirs) {
      const fleetRecord = await loadFleetRecord(fleetDir);
      fleetRecords.push(fleetRecord);
    }

    for (const fleetRecord of fleetRecords) {
      await validateFleet(fleetRecord);
    }

    fleetCount = fleetRecords.length;
  }

  console.log(
    `Validated ${agentRecords.size} repo-local agent definition(s) and ${fleetCount} fleet manifest(s).`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

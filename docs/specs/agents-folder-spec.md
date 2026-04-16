# Repo-Local Agents Folder Spec

This spec defines a lightweight repo-local contract for agent definitions that live in source control.

It is intentionally separate from AO's runtime plugin system:

- plugin packages live under `packages/plugins/*`
- orchestrator runtime config lives in `agent-orchestrator.yaml`
- repo-local agent definitions live under `agents/*`
- repo-local fleet manifests live under `fleets/*`

Use this when a repository wants to version:

- named agent personas
- reusable prompt files
- pluggable slot contracts inside an agent
- concrete configs for those slots

## Layout

```text
agents/
  _schemas/
  <agent-id>/
    agent.json
    prompts/
    slots/
      <slot-name>/
        slot.json
        configs/
        sources/
fleets/
  _schemas/
  <fleet-id>/
    fleet.json
```

## `agent.json`

Top-level manifest for one repo-local agent.

Required fields:

- `id`
- `name`
- `description`
- `systemPrompt`
- `slots`

Each slot entry defines:

- `path`: relative path to the slot directory
- `config`: default config ID to use inside that slot

## Slot Contract

Each slot directory must contain `slot.json`.

The contract declares:

- where configs live
- where prompt sources live
- what fields a config is expected to provide

Current slot families supported by the shared validator and schema set:

- `idea-generation`
- `idea-validation`
- `research-mode`
- `design-mode`
- `build-mode`
- `growth-mode`
- `launch-mode`

Each `fields[]` entry in `slot.json` declares:

- `name`
- `type`
- `required`
- `description`

The shared validator currently understands these field types:

- `string`
- `string[]`
- `markdown-path`
- `agent-slot-config-ref`

## Slot Configs

Each config is a JSON file in `configs/`.

For `idea-generation`, a config should define:

- `promptSource`
- `researchMode`
- `noveltyBar`
- `outputMode`
- `sourceTypes`
- `scoringAxes`

For `idea-validation`, a config should define:

- `promptSource`
- `ideaSource`
- `researchMode`
- `outputMode`
- `sourceTypes`
- `researchDimensions`
- `scoringAxes`
- `scoreScale`

For the new swarm slot families, the config schema files now live under `agents/_schemas/`:

- `research-mode-config.schema.json`
- `design-mode-config.schema.json`
- `build-mode-config.schema.json`
- `growth-mode-config.schema.json`
- `launch-mode-config.schema.json`

The prompt source is a Markdown file in `sources/`.

`pnpm agents:validate` validates `id` and `name` on every config, then checks the slot-specific required fields declared in that slot's `fields[]` contract.

If a field uses `agent-slot-config-ref`, the referenced agent, slot, and config must already exist in `agents/`.

## Fleet Manifests

Each fleet directory contains a `fleet.json` that composes repo-local agents into a staged workflow.

The minimal fleet contract supports:

- `id`
- `name`
- `description`
- optional `goal`
- `agents[]` with `agentId`, `stage`, optional `dependsOn`, and optional `outputs`

The starter fleet manifest is:

- `fleets/startup-factory/fleet.json`

Fleet validation is structural for now: it checks manifest shape, duplicate `agentId` entries, and that `dependsOn` references point at another agent in the same fleet manifest.

## Current Example

The repo currently includes:

- `agents/idea-sourcer/`
- slot: `idea-generation`
- config: `codex`
- `agents/idea-validator/`
- slot: `idea-validation`
- config: `codex`

## Validation

Run:

```bash
pnpm agents:validate
```

This validates the tracked repo-local agent and fleet definitions, but it does not register them as AO runtime plugins.

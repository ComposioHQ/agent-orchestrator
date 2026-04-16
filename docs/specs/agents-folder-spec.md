# Repo-Local Agents Folder Spec

This spec defines a lightweight repo-local contract for agent definitions that live in source control.

It is intentionally separate from AO's runtime plugin system:

- plugin packages live under `packages/plugins/*`
- orchestrator runtime config lives in `agent-orchestrator.yaml`
- repo-local agent definitions live under `agents/*`

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

For the current `idea-generation` slot, the contract declares:

- where configs live
- where prompt sources live
- what fields a config is expected to provide

## Slot Configs

Each config is a JSON file in `configs/`.

For `idea-generation`, a config should define:

- `promptSource`
- `researchMode`
- `noveltyBar`
- `outputMode`
- `sourceTypes`
- `scoringAxes`

The prompt source is a Markdown file in `sources/`.

## Current Example

The repo currently includes:

- `agents/idea-sourcer/`
- slot: `idea-generation`
- config: `codex`

## Validation

Run:

```bash
pnpm agents:validate
```

This validates the tracked repo-local agent definitions, but it does not register them as AO runtime plugins.

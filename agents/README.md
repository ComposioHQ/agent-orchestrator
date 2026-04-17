# Repo-Local Agents

This directory holds repo-local agent definitions that sit above AO's runtime/plugin layer.
Fleet manifests that compose those agents live alongside it under `fleets/`.

Use this when you want to define:

- a named agent persona or workflow
- prompt sources as Markdown files
- pluggable slots inside that agent
- reusable slot configs for different runtimes or strategies

## Layout

```text
agents/
  _schemas/
    agent-manifest.schema.json
    idea-generation-slot.schema.json
    idea-generation-config.schema.json
    idea-validation-slot.schema.json
    idea-validation-config.schema.json
    research-mode-slot.schema.json
    research-mode-config.schema.json
    design-mode-slot.schema.json
    design-mode-config.schema.json
    build-mode-slot.schema.json
    build-mode-config.schema.json
    growth-mode-slot.schema.json
    growth-mode-config.schema.json
    launch-mode-slot.schema.json
    launch-mode-config.schema.json
  idea-sourcer/
    agent.json
    prompts/
      system.md
    slots/
      idea-generation/
        slot.json
        configs/
          codex.json
        sources/
          codex-idea-generation.md
  idea-validator/
    agent.json
    prompts/
      system.md
    slots/
      idea-validation/
        slot.json
        configs/
          codex.json
        sources/
          codex-idea-validation.md
fleets/
  _schemas/
    fleet-manifest.schema.json
  startup-factory/
    fleet.json
```

## Concepts

- `agent.json`: top-level manifest for one repo-local agent
- `prompts/`: agent-level prompts shared across slots
- `slots/<slot-name>/slot.json`: slot contract and metadata
- `slots/<slot-name>/sources/`: Markdown prompt sources used by slot configs
- `slots/<slot-name>/configs/*.json`: concrete configurations for a slot
- `fleets/*/fleet.json`: declarative compositions of repo-local agents and handoff order

## Current Agents

- `idea-sourcer`: generates and expands candidate ideas
- `idea-validator`: pulls sourced ideas and scores them with web-backed validation research

## Supported Slot Families

- `idea-generation`
- `idea-validation`
- `research-mode`
- `design-mode`
- `build-mode`
- `growth-mode`
- `launch-mode`

Slot configs are validated from the `fields` declared in each slot's `slot.json`. The shared validator currently understands:

- `string`
- `string[]`
- `markdown-path`
- `agent-slot-config-ref`

## Fleet Manifests

- `fleets/startup-factory/fleet.json`: the startup-factory composition for `idea-sourcer`, `idea-validator`, `deep-research`, `design-studio`, `build-squad`, `growth-loop`, and `launch-desk`
- Fleet validation is intentionally structural for now, so the manifest can land before every referenced agent folder merges from parallel swarm PRs.

## Validation

Run:

```bash
pnpm agents:validate
```

The validator checks:

- every `agent.json` is readable JSON
- referenced prompt files exist
- slot manifests exist
- slot configs exist
- slot config prompt sources resolve to real Markdown files
- required slot config keys match the field contracts declared in `slot.json`
- `agent-slot-config-ref` values resolve to real repo-local agent slot configs
- `fleet.json` files have valid structure and internal `dependsOn` references

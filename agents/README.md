# Repo-Local Agents

This directory holds repo-local agent definitions that sit above AO's runtime/plugin layer.

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
```

## Concepts

- `agent.json`: top-level manifest for one repo-local agent
- `prompts/`: agent-level prompts shared across slots
- `slots/<slot-name>/slot.json`: slot contract and metadata
- `slots/<slot-name>/sources/`: Markdown prompt sources used by slot configs
- `slots/<slot-name>/configs/*.json`: concrete configurations for a slot

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

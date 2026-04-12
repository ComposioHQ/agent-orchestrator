# LLM Prompt Templates — Design

**Date:** 2026-04-11
**Branch:** `feat/llm-prompt-templates`
**Status:** Draft (pending review)

## Problem

Agent Orchestrator currently embeds all LLM-facing prompts as string literals in TypeScript source. These prompts are the primary knob for tuning agent behavior, yet editing them requires a code change, a rebuild, and a release. We want to move the defaults into YAML template files that ship with `@aoagents/ao-core`, while letting users override them per-project without forking the codebase.

## Goals

- Extract all hardcoded LLM prompts into versionable YAML template files.
- Support per-project overrides via a conventional directory (`<projectDir>/.agent-orchestrator/prompts/`) and via an explicit `promptsDir` config key.
- Preserve byte-identical default output so this refactor is invisible to existing users.
- Fail fast and loudly on template errors (missing variables, bad YAML, undeclared references).

## Non-Goals

- Hot-reload of template files during a running session.
- Template composition / `include` / inheritance.
- Versioning or migration of template schemas.
- A dashboard UI for editing prompts.
- Changing how users override reaction messages in `agent-orchestrator.yaml` (that path stays exactly as it is).

## Scope — Prompts Being Extracted

Five embedded prompts, identified by audit of `packages/core/src`:

| # | Source | What it is |
|---|--------|-----------|
| 1 | `prompt-builder.ts:21-40` — `BASE_AGENT_PROMPT` | ~20-line worker-agent system prompt (Layer 1 of the 3-layer assembly) |
| 2 | `orchestrator-prompt.ts:21-255` — `generateOrchestratorPrompt()` body | ~230-line orchestrator system prompt with `${project.*}` / `${config.*}` / `${projectId}` substitutions |
| 3 | `config.ts:538-602` — 5 default reaction messages | `ci-failed`, `changes-requested`, `bugbot-comments`, `merge-conflicts`, `agent-idle` (currently `.default(...)` values in the Zod schema) |
| 4 | `lifecycle-manager.ts:932-947` — CI failure formatter | ~15-line template that formats failed CI checks into a message sent to the agent |
| 5 | `agent-workspace-hooks.ts:267-278` — `.ao/AGENTS.md` blurb | ~10 lines appended to each workspace's `.ao/AGENTS.md` explaining metadata fallbacks |

## Architecture

### Module Layout

```
packages/core/src/prompts/
  loader.ts              # PromptLoader class (lookup, parse, validate, interpolate)
  templates/
    base-agent.yaml
    orchestrator.yaml
    reactions.yaml
    ci-failure.yaml
    agent-workspace.yaml
packages/core/src/__tests__/prompts/
  loader.test.ts
```

The templates live under `src/` so the build pipeline ships them with the package. Runtime path resolution uses `path.join(__dirname, "prompts", "templates", ...)` which works for both `src/` (vitest via tsx) and `dist/` (published package), assuming the build copies `*.yaml` to `dist/`. The implementation step verifies the current build tooling and adds a minimal asset-copy step if needed.

### YAML Schema

Two shapes, both validated with Zod at load time.

**Single-template file** (used by 4 of the 5 files):

```yaml
name: orchestrator
description: System prompt for the orchestrator agent managing worker sessions
variables:
  - project.name
  - project.repo
  - project.defaultBranch
  - project.sessionPrefix
  - config.port
  - projectId
template: |
  You are an orchestrator for ${project.name} (${project.repo}).
  Default branch: ${project.defaultBranch}
  ...
```

**Reactions file** (`reactions.yaml` only) — a map of short templates, grouped because they are logically one set:

```yaml
name: reactions
description: Default messages sent to agents during lifecycle transitions
reactions:
  ci-failed:
    description: Sent when CI fails on the agent's PR
    variables: []
    template: |
      CI is failing on your PR. Run `gh pr checks`...
  changes-requested:
    description: Sent when a reviewer requests changes
    variables: []
    template: |
      There are review comments on your PR...
  # bugbot-comments, merge-conflicts, agent-idle
```

Zod:

```ts
const SingleTemplate = z.object({
  name: z.string(),
  description: z.string(),
  variables: z.array(z.string()).default([]),
  template: z.string(),
});

const ReactionsFile = z.object({
  name: z.literal("reactions"),
  description: z.string(),
  reactions: z.record(
    z.object({
      description: z.string(),
      variables: z.array(z.string()).default([]),
      template: z.string(),
    }),
  ),
});
```

### Loader API

```ts
// packages/core/src/prompts/loader.ts

export interface PromptLoaderOptions {
  projectDir: string;   // absolute path to project root
  promptsDir?: string;  // optional override from agent-orchestrator.yaml
}

export class PromptLoader {
  constructor(options: PromptLoaderOptions);

  /** Load a single-template file, validate declared vs. provided variables, and render. */
  render(name: string, vars: Record<string, unknown>): string;

  /** Load reactions.yaml and render one keyed reaction. */
  renderReaction(key: string, vars?: Record<string, unknown>): string;
}
```

### Lookup Order

Per-file, first hit wins:

1. `<options.promptsDir>/<name>.yaml` — if `promptsDir` is set in config
2. `<options.projectDir>/.agent-orchestrator/prompts/<name>.yaml` — conventional default location
3. `<coreDist>/prompts/templates/<name>.yaml` — bundled default

`promptsDir` is resolved relative to `projectDir` (not `process.cwd()`) when it is not absolute. This is documented in `agent-orchestrator.yaml.example`.

Partial overrides are supported by design: a user can place only `orchestrator.yaml` in their project directory and everything else falls through to bundled defaults.

### Interpolation

A ~20-line function, no external dependencies:

```ts
function interpolate(
  template: string,
  vars: Record<string, unknown>,
  declared: string[],
): string {
  // 1. Scan template for ${path.to.key} occurrences.
  //    Every scanned key must appear in `declared`.
  // 2. Every key in `declared` must resolve in `vars`.
  //    Missing values throw with the key name and template name.
  // 3. Replace each ${path} by walking `vars` via dotted path.
  //    Values are coerced with String().
}
```

Dotted-path resolution means existing call sites do not need to reshape their context objects. They pass `{ project, config, projectId }` and the template references `${project.name}` as it does today.

### Caching

Parsed `{ raw, zod-validated }` templates are cached per-loader-instance in a `Map<string, ParsedTemplate>`. No TTL — the cache lives for the lifetime of the `SessionManager` that owns the loader. Operators who edit templates restart the orchestrator to pick up changes; this matches how they already handle `agent-orchestrator.yaml` edits.

### Error Cases

All throw with descriptive messages. No silent fallback.

- File not found at any lookup path (includes all 3 paths in the error).
- YAML parse error (includes file path and line/column).
- Zod schema validation failure (includes file path and zod error).
- Template references `${undeclared.var}` that is not listed in `variables`.
- Declared variable not provided at render call.
- Unknown reaction key in `renderReaction()`.

## Integration Points

Each existing embedded prompt is replaced in one place.

**1. `prompt-builder.ts` — `BASE_AGENT_PROMPT`**
- Delete the exported constant.
- `buildPrompt()` gains a `loader: PromptLoader` parameter.
- Layer 1 becomes `loader.render("base-agent", {})`.
- All callers (currently `session-manager.ts` spawn path) thread the loader through.

**2. `orchestrator-prompt.ts` — `generateOrchestratorPrompt()`**
- Function signature gains a `loader` param.
- Body reduces to `return loader.render("orchestrator", { project, config, projectId });`.
- The ~230-line template moves verbatim into `orchestrator.yaml` — same `${…}` syntax, zero transformation.

**3. `config.ts` — 5 default reaction messages**
- Current state: Zod schema defaults (`.default(...)`) evaluated at module load. The loader does not exist at that point.
- Change: remove the `.default(...)` values from the schema. After `parseConfig()` returns, a new post-parse step `applyReactionDefaults(config, loader)` fills in any reaction slot the user did not explicitly set, using `loader.renderReaction(key)`.
- User-override semantics preserved: a user-set `reactions.ci-failed` in `agent-orchestrator.yaml` still wins exactly as today. This refactor only moves the *defaults* out of the schema.

**4. `lifecycle-manager.ts:932-947` — Dynamic CI failure formatter**
- The template literal moves to `ci-failure.yaml`.
- The per-check bullet list (`- **${name}**: ${status} — ${url}`) is pre-formatted by the caller into a single `${failedChecksList}` string, which is then passed as a variable. This keeps the loader's variable model scalar-only — no looping in templates.

**5. `agent-workspace-hooks.ts:267-278` — `.ao/AGENTS.md` blurb**
- Moves to `agent-workspace.yaml`.
- `setupPathWrapperWorkspace` (and any other caller) gains a `loader` param. The loader is already in scope wherever a session is being set up.

### New Config Key

One optional addition to `agent-orchestrator.yaml`:

```yaml
# Optional: directory to search for prompt template overrides.
# Absolute or relative to the project directory. If unset, falls back to
# <projectDir>/.agent-orchestrator/prompts/ and then to bundled defaults.
promptsDir: ./my-custom-prompts
```

Documented in `agent-orchestrator.yaml.example`.

## Backward Compatibility

No user-visible behavior change when `promptsDir` is unset and no `.agent-orchestrator/prompts/` directory exists. Bundled YAML defaults produce output byte-identical to today's embedded strings. A snapshot-style test (`prompt-builder.test.ts`, `orchestrator-prompt.test.ts`) asserts this for the two large prompts and prevents accidental whitespace drift during the extraction.

## Testing

### `loader.test.ts` (new)

1. Loads and renders a bundled template with variables.
2. Project-local override at `<projectDir>/.agent-orchestrator/prompts/foo.yaml` wins over bundled.
3. Explicit `promptsDir` wins over project-local.
4. Throws on missing file at all 3 paths.
5. Throws on invalid YAML.
6. Throws on Zod schema failure (missing `template`, wrong types).
7. Throws when `template` references `${undeclared.var}`.
8. Throws when render call omits a declared variable.
9. Dotted-path interpolation walks nested objects.
10. `renderReaction("ci-failed")` returns correct string.
11. `renderReaction` with unknown key throws.
12. Cache: second render of same file does not re-read disk (spy on `fs.readFileSync`).

### Updated Existing Tests

- `prompt-builder.test.ts` — assert `buildPrompt(...)` output matches today's behavior (golden string).
- `orchestrator-prompt.test.ts` — same, for the orchestrator prompt.
- `session-manager/spawn.test.ts` — pass a real `PromptLoader` (pointed at bundled templates) or a test double.
- `config.test.ts` — verify reaction defaults are applied when user YAML omits them; verify user-set values still override.

### No New E2E

This is a pure refactor behind a stable interface. Existing integration tests exercise the code paths that use the loader.

## Implementation Notes

### YAML Parser

Use whichever parser `@aoagents/ao-core` already depends on. If neither `js-yaml` nor `yaml` is in the dependency tree, add `js-yaml` — it is the smallest trustworthy option.

### Build / Asset Copy

During implementation, verify the core package build (`tsc` or `tsup`) copies `src/prompts/templates/*.yaml` into `dist/prompts/templates/`. If it does not, add a minimal postbuild step to the package script. Runtime path resolution via `__dirname` makes both `src/` (test) and `dist/` (prod) work uniformly.

### Relative `promptsDir`

Resolved against `projectDir`, not `process.cwd()`. This matches how the rest of the project config keys behave and avoids surprises when the CLI is invoked from a subdirectory.

## Summary of Deliverables

- `packages/core/src/prompts/loader.ts`
- `packages/core/src/prompts/templates/{base-agent,orchestrator,reactions,ci-failure,agent-workspace}.yaml`
- `packages/core/src/__tests__/prompts/loader.test.ts`
- Refactored: `prompt-builder.ts`, `orchestrator-prompt.ts`, `config.ts`, `lifecycle-manager.ts`, `agent-workspace-hooks.ts`
- Updated tests: `prompt-builder.test.ts`, `orchestrator-prompt.test.ts`, `session-manager/spawn.test.ts`, `config.test.ts`
- One new optional config key (`promptsDir`) with documentation in `agent-orchestrator.yaml.example`
- Zero user-visible behavior change when no overrides are configured

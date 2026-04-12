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
- Looping or conditionals inside templates. Any repeating or optional content is pre-formatted to a scalar string by the caller and passed in as a declared variable.
- Moving non-message reaction defaults (`auto`, `action`, `retries`, `escalateAfter`, `priority`, `threshold`, `includeSummary`) out of `applyDefaultReactions`. Only the 6 `message` strings are in scope.
- Moving other string constants in core (`PREFERRED_GH_PATH`, tmux setup strings, etc.) out of code. Not prompts, not in scope.

## Scope — Prompts Being Extracted

Five embedded prompts, identified by audit of `packages/core/src`:

| # | Source | What it is |
|---|--------|-----------|
| 1 | `prompt-builder.ts:21-40` — `BASE_AGENT_PROMPT` | ~20-line worker-agent system prompt (Layer 1 of the 3-layer assembly) |
| 2 | `orchestrator-prompt.ts:21-255` — `generateOrchestratorPrompt()` body | ~230-line orchestrator system prompt with `${project.*}` / `${config.*}` / `${projectId}` substitutions, plus two optional sections (reactions, project-specific rules) that are conditionally appended |
| 3 | `config.ts:537-608` — 6 default reaction **messages** | `ci-failed`, `changes-requested`, `bugbot-comments`, `merge-conflicts`, `approved-and-green`, `agent-idle` (the `message` fields only — other defaults like `auto`, `action`, `retries`, `escalateAfter`, `priority`, `threshold` stay in `applyDefaultReactions`) |
| 4 | `lifecycle-manager.ts:932-947` — CI failure formatter | ~15-line template that formats failed CI checks into a message sent to the agent |
| 5 | `agent-workspace-hooks.ts:267-278` — `.ao/AGENTS.md` blurb | ~10 lines appended to each workspace's `.ao/AGENTS.md` explaining metadata fallbacks; no variables |

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

The templates live under `src/` so the build pipeline ships them with the package. Runtime path resolution uses `path.join(path.dirname(fileURLToPath(import.meta.url)), "templates", ...)` — **not** `__dirname`, because `@aoagents/ao-core` is an ESM package (`"type": "module"` in `package.json`) where `__dirname` is not defined. This resolution works uniformly for both `src/` (vitest via tsx) and `dist/` (published package), assuming the build copies `*.yaml` to `dist/`. The implementation step verifies the current build tooling and adds a minimal asset-copy step if needed.

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

**Reactions file** (`reactions.yaml` only) — a map of short templates, grouped because they are logically one set. Contains the 6 message-carrying reactions; open-record schema so users may add their own project-specific reaction keys in override files:

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
  # bugbot-comments, merge-conflicts, approved-and-green, agent-idle
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
  // 1. For each key in `declared`, resolve it in `vars` by walking the
  //    dotted path. Missing values throw with the key name and template name.
  // 2. Replace every `${<declared-key>}` occurrence with the resolved value,
  //    coerced via String(). Only keys listed in `declared` are substituted.
  // 3. Every other `${...}` occurrence — including shell examples inside
  //    fenced code blocks like `${pr_number}` — passes through unchanged.
  //    This is the escape story: declare a key to substitute it, omit it
  //    to leave it literal.
}
```

**Declared-only substitution is load-bearing.** The existing orchestrator prompt contains shell-example `${…}` patterns (and so does any future template that shows a command line). A naive "substitute every `${…}`" approach would flag these as undeclared and throw. Restricting substitution to the declared set gives us a natural escape mechanism without introducing `$${}` or backslash escaping.

Dotted-path resolution means existing call sites do not need to reshape their context objects. They pass `{ project, config, projectId }` and the template references `${project.name}` as it does today.

### Sync by Design

Both `render()` and `renderReaction()` are **synchronous**. File I/O uses `fs.readFileSync`, YAML parsing uses `js-yaml`'s synchronous `load` (pinning the parser choice here so the implementation does not have to re-decide). This matches the existing signatures of `buildPrompt()`, `generateOrchestratorPrompt()`, and `setupPathWrapperWorkspace()` — all synchronous today — and avoids rippling `async` through spawn paths and plugin APIs. The cache test (`loader.test.ts` #12) spies on `fs.readFileSync` to verify subsequent calls for the same file do not re-read from disk.

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
- Body becomes: pre-format the two optional sections into scalar strings, then `return loader.render("orchestrator", { project, config, projectId, reactionsSection, projectRulesSection });`.
- Most of the ~230-line template moves as-is into `orchestrator.yaml`. The conditional/looping parts do NOT:
  - **Reactions section** (`orchestrator-prompt.ts:173-195`): the function loops over `project.reactions`, emits per-entry bullet lines with branching on `reaction.action` (`send-to-agent` vs `notify`), wraps them in a `## Automated Reactions` header, and appends the whole block only when at least one reaction exists. This cannot be expressed in scalar-only interpolation. Strategy: the pre-formatting stays in the function, producing either a ready-to-insert markdown blob or an empty string, passed as the declared variable `${reactionsSection}`. The YAML template contains a single `${reactionsSection}` placeholder at the correct position with a leading blank line so the template joins cleanly whether or not the section is present.
  - **Project-specific rules section** (`orchestrator-prompt.ts:248-252`): similarly, the function builds `"## Project-Specific Rules\n\n" + project.orchestratorRules` when `project.orchestratorRules` is set, else an empty string, and passes it as `${projectRulesSection}`.
- The function's `sections.join("\n\n")` shape is preserved by authoring `orchestrator.yaml` as one block scalar with the same `\n\n` separators literally present in the YAML, so the `${reactionsSection}` and `${projectRulesSection}` placeholders sit exactly where the conditional `sections.push(...)` calls sat in the original code. A snapshot test (see Testing) asserts byte-identical output for a set of fixture configs that exercise all four combinations (reactions ∈ {none, present} × projectRules ∈ {absent, present}).
- **No looping or conditionals in templates.** This is the same pattern ci-failure.yaml uses (the caller pre-formats the failed-checks bullet list into a single `${failedChecksList}` scalar). Keeping one interpolation model across all templates is a deliberate simplicity choice.
- **The function, not the template, owns the leading whitespace for optional sections.** `reactionsSection` and `projectRulesSection` return values include their own leading `\n\n` when non-empty, and the empty string when absent. The YAML template has `${reactionsSection}` and `${projectRulesSection}` sitting flush against the adjacent content (no YAML-level whitespace). This invariant must be preserved or byte-identity breaks — worth a one-line code comment in the refactored function.

**3. `config.ts` — 6 default reaction messages**
- Current state: `applyDefaultReactions(config)` (lines 537-608) holds a `defaults` object with 11 reaction entries. Six of them (`ci-failed`, `changes-requested`, `bugbot-comments`, `merge-conflicts`, `approved-and-green`, `agent-idle`) carry a `message` string. The other five (`agent-stuck`, `agent-needs-input`, `agent-exited`, `all-complete`, plus non-message fields of the message-carrying entries) have no `message`.
- **Only the `message` fields move to YAML.** All other defaults (`auto`, `action`, `retries`, `escalateAfter`, `priority`, `threshold`, `includeSummary`) stay in `applyDefaultReactions` exactly as they are. This keeps the scope tight and avoids redesigning reaction defaults in this PR.
- Change: `applyDefaultReactions` gains a `loader: PromptLoader` parameter. For each of the 6 message-carrying entries, the `message` field is no longer a hardcoded string literal — it is `loader.renderReaction(eventKey)`. The non-message fields remain literal in the `defaults` object. The existing "user wins" merge semantics (`{ ...defaults, ...config.reactions }`) are preserved unchanged.
- The loader is constructed in the config-loading code path (currently `loadConfig` / `parseConfig`) and threaded into `applyDefaultReactions`. The caller that parses `agent-orchestrator.yaml` already has the `projectDir` needed to construct the loader.
- User-override semantics preserved: a user-set `reactions.ci-failed.message` in `agent-orchestrator.yaml` still wins exactly as today. This refactor only moves the default *message strings* out of code.

**4. `lifecycle-manager.ts:932-947` — Dynamic CI failure formatter**
- The template literal moves to `ci-failure.yaml`.
- The per-check bullet list (`- **${name}**: ${status} — ${url}`) is pre-formatted by the caller into a single `${failedChecksList}` string, which is then passed as a variable. This keeps the loader's variable model scalar-only — no looping in templates.

**5. `agent-workspace-hooks.ts:267-278` — `.ao/AGENTS.md` blurb**
- Moves to `agent-workspace.yaml`.
- `setupPathWrapperWorkspace` is a public core export consumed by **four agent plugins** today (`agent-codex`, `agent-aider`, `agent-opencode`, `agent-cursor`). The `agent-claude-code` plugin uses native `.claude/settings.json` PostToolUse hooks and does not call `setupPathWrapperWorkspace`. Threading a `loader` parameter through it would still change a plugin-boundary API and require coordinated updates in every PATH-wrapper agent plugin for a blurb that takes **no variables** — pure YAGNI.
- **Alternative adopted:** `agent-workspace-hooks.ts` uses a **module-level lazy default loader** scoped to the bundled templates directory. On first call, it constructs a `PromptLoader` with `projectDir = workspacePath` (so a user's project-local override at `<workspacePath>/.agent-orchestrator/prompts/agent-workspace.yaml` still works if they want it) and caches the parsed blurb for the module's lifetime. No plugin signatures change.
- Because this blurb has no variables, it bypasses the full lookup-chain dance only in the sense that there is nothing to interpolate — the loader still performs the full project-local → bundled-default lookup. The only thing skipped is a `promptsDir` config lookup, because `agent-workspace-hooks.ts` does not have a config object in scope at call time. This is a deliberate trade-off: project-local `.agent-orchestrator/prompts/agent-workspace.yaml` still overrides the bundled default, but the explicit `promptsDir` override does not apply to this specific template. Documented in the YAML file and in `agent-orchestrator.yaml.example`.

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

No user-visible behavior change when `promptsDir` is unset and no `.agent-orchestrator/prompts/` directory exists. Bundled YAML defaults produce output byte-identical to today's embedded strings.

**Whitespace is the high-risk area.** `generateOrchestratorPrompt()` builds its output with `sections.join("\n\n")`, each section being a template literal whose leading/trailing whitespace matters. YAML block scalars (`|`, `|-`, `|+`, `>`) have their own rules about trailing newlines, and the YAML parser will normalize them on load. The authoring rule for `orchestrator.yaml` is:
- Use the `|` block scalar (keeps final newline) and place the entire concatenated body — including the exact `\n\n` section separators that `sections.join("\n\n")` would produce — literally inside.
- Place `${reactionsSection}` and `${projectRulesSection}` placeholders with a leading `\n\n` inside the placeholder contents themselves (i.e. the function returns `"\n\n## Automated Reactions\n\n..."` or `""`), not in the YAML surroundings. This way the template has no conditional whitespace and the empty-string case produces exactly the same output as the current "section never pushed" path.

Snapshot-style tests (`prompt-builder.test.ts`, `orchestrator-prompt.test.ts`) assert byte-identical output for both prompts across the cartesian product of relevant fixture configs — eight orchestrator fixtures (see Testing) — and prevent accidental whitespace drift during the extraction. The tests run against the current (pre-refactor) golden strings captured from HEAD before any file is edited.

## Testing

### `loader.test.ts` (new)

1. Loads and renders a bundled template with variables.
2. Project-local override at `<projectDir>/.agent-orchestrator/prompts/foo.yaml` wins over bundled.
3. Explicit `promptsDir` wins over project-local.
4. Throws on missing file at all 3 paths (error message lists all paths checked).
5. Throws on invalid YAML.
6. Throws on Zod schema failure (missing `template`, wrong types).
7. Throws when render call omits a declared variable.
8. Dotted-path interpolation walks nested objects.
9. **Escape behavior:** `${undeclared.thing}` inside a template body passes through literally when `undeclared.thing` is not in the `variables` list. (This is the shell-example-in-code-fence guarantee.)
10. `renderReaction("ci-failed")` returns correct string.
11. `renderReaction` with unknown key throws.
12. Cache: second render of same file does not re-read disk (spy on `fs.readFileSync`).
13. `render` and `renderReaction` are synchronous (not `Promise`-returning).

### Updated Existing Tests

- `prompt-builder.test.ts` — assert `buildPrompt(...)` output matches today's behavior against a golden string captured from HEAD before the refactor.
- `orchestrator-prompt.test.ts` — assert byte-identical output for the cartesian product of (reactions ∈ {none, present-send-to-agent, present-notify, mixed}) × (projectRules ∈ {absent, present}) — eight fixture configs total. Golden strings captured from HEAD before the refactor.
- `session-manager/spawn.test.ts` — pass a real `PromptLoader` (pointed at bundled templates) via a shared `createTestPromptLoader()` helper in a `__tests__/prompts/fixtures.ts` or equivalent test-utils module, so every test file gets the same bundled-templates loader without re-wiring.
- `config.test.ts` — verify reaction default *messages* are applied when user YAML omits them; verify user-set messages still override; verify non-message fields (`auto`, `retries`, etc.) are unchanged.

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

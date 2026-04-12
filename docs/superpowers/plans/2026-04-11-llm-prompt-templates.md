# LLM Prompt Templates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract 5 hardcoded LLM prompts from `@aoagents/ao-core` into versionable YAML template files, with project-local and config-based overrides, preserving byte-identical default output.

**Architecture:** A new `PromptLoader` class in `packages/core/src/prompts/` reads YAML templates from a lookup chain (explicit `promptsDir` → project-local `.agent-orchestrator/prompts/` → bundled defaults) and performs declared-only variable interpolation. Callers (session manager, lifecycle manager, CLI, web API, config post-processor, workspace hooks) are refactored to obtain prompts through the loader instead of from inline string literals.

**Tech Stack:** TypeScript 5.7 (ESM, `Node16` module resolution), Zod 3 (schema validation), `yaml` 2.7 (already a core dep, synchronous `parse`), Vitest (tests), fs sync APIs (`readFileSync`), `fileURLToPath(import.meta.url)` for ESM-safe path resolution.

**Spec:** See `docs/superpowers/specs/2026-04-11-llm-prompt-templates-design.md` for the full design. This plan is the execution-ready expansion.

---

## Pre-flight

- **Branch:** `feat/llm-prompt-templates` (already exists, branched from `main` at `f7ef5360`)
- **Working directory:** `/Users/vitor/LocalProjects/agent-orchestrator`
- **Build command:** `pnpm build` (root) or `pnpm --filter @aoagents/ao-core build` (core only)
- **Test commands:**
  - Core only: `pnpm --filter @aoagents/ao-core test`
  - All: `pnpm test`
- **Typecheck:** `pnpm typecheck`
- **Node version:** 20+
- **Known constraint:** `@aoagents/ao-core` is ESM (`"type": "module"`) — use `import.meta.url`, NOT `__dirname`

## File Structure

### New files

```
packages/core/src/prompts/
  loader.ts                              # PromptLoader class + interpolate helper + Zod schemas
  templates/
    base-agent.yaml                      # ~20-line worker system prompt
    orchestrator.yaml                    # ~230-line orchestrator system prompt
    reactions.yaml                       # 6 reaction messages (map)
    ci-failure.yaml                      # CI failure formatter template
    agent-workspace.yaml                 # .ao/AGENTS.md blurb
packages/core/src/__tests__/prompts/
  loader.test.ts                         # 13 unit tests (see Task 2)
  fixtures.ts                            # createTestPromptLoader() helper
  fixtures/                              # tiny override YAML files used by tests
    override-wins.yaml
    invalid-schema.yaml
    not-yaml.yaml
agent-orchestrator.yaml.example          # NOT new — documents new promptsDir key (in Task 10)
```

### Modified files

| File | Responsibility | Task |
|------|---------------|------|
| `packages/core/package.json` | Add postbuild asset copy step | Task 1 |
| `packages/core/src/types.ts` | Re-export `PromptLoader` type + add `promptsDir` to `OrchestratorConfig` | Task 3 |
| `packages/core/src/config.ts` | Add `promptsDir` to Zod schema; thread loader into `applyDefaultReactions` | Task 7 |
| `packages/core/src/prompt-builder.ts` | Delete `BASE_AGENT_PROMPT`; `buildPrompt` takes `loader` via config | Task 4 |
| `packages/core/src/orchestrator-prompt.ts` | Delegate to loader; pre-format optional sections as scalars | Task 5 |
| `packages/core/src/lifecycle-manager.ts` | `formatCIFailureMessage` uses loader; `LifecycleManagerDeps` gains `promptLoader` | Task 6 |
| `packages/core/src/agent-workspace-hooks.ts` | Replace `AO_AGENTS_MD_SECTION` constant with module-level lazy loader | Task 8 |
| `packages/core/src/session-manager.ts` | `SessionManagerDeps` accepts `promptLoaderFactory`; thread into spawn path | Task 9 |
| `packages/core/src/index.ts` | Export `PromptLoader` and related types | Task 3 |
| `packages/cli/src/commands/start.ts` | Pass loader to `generateOrchestratorPrompt` | Task 5 |
| `packages/web/src/app/api/orchestrators/route.ts` | Pass loader to `generateOrchestratorPrompt` | Task 5 |
| `packages/cli/src/lib/create-session-manager.ts` | Pass prompt loader factory when creating session manager | Task 9 |
| `packages/web/src/lib/services.ts` | Same — pass factory | Task 9 |
| `packages/core/src/__tests__/prompt-builder.test.ts` | Update for new signature; add golden snapshot | Task 4 |
| `packages/core/src/__tests__/orchestrator-prompt.test.ts` | Update for new signature; add 8-fixture cartesian | Task 5 |
| `packages/core/src/__tests__/config.test.ts` (if exists) | Verify reaction default messages still apply | Task 7 |
| `agent-orchestrator.yaml.example` | Document `promptsDir` | Task 10 |

## Task Decomposition Overview

| # | Task | Depends on |
|---|------|-----------|
| 0 | Capture golden strings from HEAD (frozen pre-refactor output) | — |
| 1 | Build-pipeline asset copy + empty prompts directory | — |
| 2 | PromptLoader class + unit tests (TDD) | 1 |
| 3 | Public type exports + `promptsDir` on config schema | 2 |
| 4 | Extract `BASE_AGENT_PROMPT` → `base-agent.yaml` + refactor `buildPrompt` | 2, 3, 0 |
| 5 | Extract orchestrator prompt → `orchestrator.yaml` + refactor `generateOrchestratorPrompt` + update 2 callers | 2, 3, 0 |
| 6 | Extract CI failure formatter → `ci-failure.yaml` + wire into `lifecycle-manager.ts` | 2, 3 |
| 7 | Extract 6 reaction messages → `reactions.yaml` + refactor `applyDefaultReactions` | 2, 3 |
| 8 | Extract `.ao/AGENTS.md` blurb → `agent-workspace.yaml` + module-level loader | 2 |
| 9 | Thread PromptLoader through `SessionManagerDeps` and call sites | 4, 5, 6, 7 |
| 10 | Document `promptsDir` in `agent-orchestrator.yaml.example` | 3 |
| 11 | Full typecheck + full test suite + integration smoke | 9, 10 |

**Total estimated tasks:** 12 (0–11). Each task below is broken into bite-sized steps.

---

## Task 0: Capture golden strings from HEAD

**Purpose:** Freeze the current (pre-refactor) output of `buildPrompt` and `generateOrchestratorPrompt` so Tasks 4 and 5 can verify byte-identical extraction. This runs BEFORE any source file is edited.

**Files:**
- Create: `packages/core/src/__tests__/prompts/golden/base-agent-minimal.txt`
- Create: `packages/core/src/__tests__/prompts/golden/orchestrator-*.txt` (8 files)
- Create: `packages/core/src/__tests__/prompts/capture-golden.mjs` (one-shot script — **deleted after use**, not committed)

- [ ] **Step 0.1: Make the golden directory**

```bash
mkdir -p packages/core/src/__tests__/prompts/golden
```

- [ ] **Step 0.2: Write the capture script**

Create `packages/core/src/__tests__/prompts/capture-golden.mjs`:

```js
// One-shot capture of current prompt output. Delete after running.
import { buildPrompt } from "../../prompt-builder.ts";
import { generateOrchestratorPrompt } from "../../orchestrator-prompt.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = join(__dirname, "golden");
mkdirSync(out, { recursive: true });

const baseProject = {
  name: "TestProj",
  repo: "owner/testproj",
  path: "/tmp/testproj",
  defaultBranch: "main",
  sessionPrefix: "tp",
};

// 1 base-agent fixture (buildPrompt minimal — no issue, no userPrompt, no rules)
writeFileSync(
  join(out, "base-agent-minimal.txt"),
  buildPrompt({ project: baseProject, projectId: "test" }),
);

// 8 orchestrator fixtures — cartesian of reactions × projectRules
const reactionsCases = {
  "none": undefined,
  "send-to-agent": {
    "ci-failed": { auto: true, action: "send-to-agent", retries: 2, escalateAfter: 2 },
  },
  "notify": {
    "approved-and-green": { auto: true, action: "notify", priority: "action" },
  },
  "mixed": {
    "ci-failed": { auto: true, action: "send-to-agent" },
    "approved-and-green": { auto: true, action: "notify", priority: "info" },
  },
};
const rulesCases = {
  "no-rules": undefined,
  "with-rules": "Be extra careful with database migrations.",
};

for (const [rk, reactions] of Object.entries(reactionsCases)) {
  for (const [pk, orchestratorRules] of Object.entries(rulesCases)) {
    const prompt = generateOrchestratorPrompt({
      config: { port: 3000 },
      projectId: "test",
      project: { ...baseProject, reactions, orchestratorRules },
    });
    writeFileSync(join(out, `orchestrator-${rk}-${pk}.txt`), prompt);
  }
}
console.log("✓ Golden files written to", out);
```

- [ ] **Step 0.3: Run the capture**

```bash
cd packages/core && pnpm tsx src/__tests__/prompts/capture-golden.mjs
```

Expected: `✓ Golden files written to ...` and 9 new files in `packages/core/src/__tests__/prompts/golden/`.

If `tsx` is not available, use `pnpm exec tsx` or install it transiently. If neither works, compile and run with plain node after adjusting imports to the compiled paths.

- [ ] **Step 0.4: Delete the one-shot script (do NOT commit it)**

```bash
rm packages/core/src/__tests__/prompts/capture-golden.mjs
```

- [ ] **Step 0.5: Commit the golden files only**

```bash
git add packages/core/src/__tests__/prompts/golden/
git commit -m "test(core): capture pre-refactor golden output for prompt templates"
```

---

## Task 1: Build-pipeline asset copy

**Purpose:** `tsc` does not copy non-`.ts` files from `src/` into `dist/`. Our YAML templates must ship inside the published package, so we add a minimal postbuild step. We also add the empty directory structure.

**Files:**
- Modify: `packages/core/package.json` (`scripts.build`)
- Create: `packages/core/src/prompts/` (empty dir, staged via a `.gitkeep` which is removed in Task 2)

- [ ] **Step 1.1: Create the prompts directory skeleton**

```bash
mkdir -p packages/core/src/prompts/templates
```

- [ ] **Step 1.2: Update the build script**

Edit `packages/core/package.json`. Change:

```json
"build": "tsc -p tsconfig.build.json",
```

to:

```json
"build": "tsc -p tsconfig.build.json && node ../../scripts/copy-prompt-templates.mjs",
```

**Decision:** Use a Node script (not `cp -r`) so the build works on Windows/CI runners where `cp -r` behavior may differ, and so we can log which files were copied.

- [ ] **Step 1.3: Create the copy script**

Create `scripts/copy-prompt-templates.mjs` at the repo root (if `scripts/` doesn't exist, create it):

```js
#!/usr/bin/env node
/**
 * Postbuild step for @aoagents/ao-core: copy prompt template YAML files
 * from src/prompts/templates/ to dist/prompts/templates/.
 *
 * tsc does not copy non-TS assets. This script is invoked after `tsc` in
 * the core package's build script.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(__dirname, "..", "packages", "core");
const srcDir = join(coreRoot, "src", "prompts", "templates");
const dstDir = join(coreRoot, "dist", "prompts", "templates");

if (!existsSync(srcDir)) {
  console.warn(`[copy-prompt-templates] src dir missing: ${srcDir}`);
  process.exit(0);
}

mkdirSync(dstDir, { recursive: true });
cpSync(srcDir, dstDir, { recursive: true });

const copied = readdirSync(dstDir);
console.log(`[copy-prompt-templates] copied ${copied.length} files → ${dstDir}`);
```

Make it executable (optional, since we invoke with `node`):

```bash
chmod +x scripts/copy-prompt-templates.mjs
```

- [ ] **Step 1.4: Verify core still builds (it won't do anything new yet)**

```bash
pnpm --filter @aoagents/ao-core build
```

Expected: build succeeds, script reports `copied 0 files → .../dist/prompts/templates` (directory exists but is empty).

- [ ] **Step 1.5: Commit**

```bash
git add scripts/copy-prompt-templates.mjs packages/core/package.json
git commit -m "build(core): copy prompt template YAML files to dist in postbuild"
```

---

## Task 2: PromptLoader class + unit tests (TDD)

**Purpose:** Build the reusable loader with a fail-fast contract. Done TDD — tests first, then implementation.

**Files:**
- Create: `packages/core/src/prompts/loader.ts`
- Create: `packages/core/src/__tests__/prompts/loader.test.ts`
- Create: `packages/core/src/__tests__/prompts/fixtures.ts`
- Create: `packages/core/src/__tests__/prompts/fixtures/override-wins.yaml`
- Create: `packages/core/src/__tests__/prompts/fixtures/invalid-schema.yaml`
- Create: `packages/core/src/__tests__/prompts/fixtures/not-yaml.yaml`

Use @superpowers:test-driven-development discipline throughout this task.

- [ ] **Step 2.1: Write the test file (all 13 tests, all failing)**

Create `packages/core/src/__tests__/prompts/loader.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as fs from "node:fs";

import { PromptLoader } from "../../prompts/loader.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `prompt-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("PromptLoader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("1. loads and renders a bundled template with variables", () => {
    // base-agent is a bundled template (written in Task 4) — but for this
    // unit test use a minimal bundled template we create via Task 2 itself.
    // Until base-agent.yaml exists, test this with a project-local override.
    const projectDir = tmp;
    const promptsDir = join(projectDir, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "greet.yaml"),
      `name: greet
description: test
variables:
  - user.name
template: |
  Hello, \${user.name}!`,
    );

    const loader = new PromptLoader({ projectDir });
    const out = loader.render("greet", { user: { name: "Alice" } });
    expect(out.trim()).toBe("Hello, Alice!");
  });

  it("2. project-local override wins over bundled", () => {
    // This test uses the bundled 'base-agent' template (exists after Task 4).
    // Until Task 4, this test can be marked .todo() or run against a fake bundled dir.
    // For execution order purposes, we implement this once base-agent.yaml exists.
    const projectDir = tmp;
    const promptsDir = join(projectDir, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "base-agent.yaml"),
      `name: base-agent
description: override
variables: []
template: |
  OVERRIDE_MARKER`,
    );

    const loader = new PromptLoader({ projectDir });
    const out = loader.render("base-agent", {});
    expect(out.trim()).toBe("OVERRIDE_MARKER");
  });

  it("3. explicit promptsDir wins over project-local", () => {
    const projectDir = tmp;
    const projectLocal = join(projectDir, ".agent-orchestrator", "prompts");
    mkdirSync(projectLocal, { recursive: true });
    writeFileSync(
      join(projectLocal, "greet.yaml"),
      `name: greet
description: project-local
variables: []
template: |
  PROJECT_LOCAL`,
    );
    const explicit = join(projectDir, "custom");
    mkdirSync(explicit, { recursive: true });
    writeFileSync(
      join(explicit, "greet.yaml"),
      `name: greet
description: explicit
variables: []
template: |
  EXPLICIT`,
    );

    const loader = new PromptLoader({ projectDir, promptsDir: explicit });
    expect(loader.render("greet", {}).trim()).toBe("EXPLICIT");
  });

  it("4. throws on missing file at all 3 paths", () => {
    const loader = new PromptLoader({ projectDir: tmp });
    expect(() => loader.render("does-not-exist", {})).toThrow(/does-not-exist/);
    expect(() => loader.render("does-not-exist", {})).toThrow(/not found/i);
  });

  it("5. throws on invalid YAML", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "broken.yaml"), "name: foo\n  bad-indent: [\n");
    const loader = new PromptLoader({ projectDir: tmp });
    expect(() => loader.render("broken", {})).toThrow();
  });

  it("6. throws on Zod schema failure", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "bad.yaml"), `name: bad\n# missing description and template`);
    const loader = new PromptLoader({ projectDir: tmp });
    expect(() => loader.render("bad", {})).toThrow(/schema|template|description/i);
  });

  it("7. throws when render call omits a declared variable", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "needs-var.yaml"),
      `name: needs-var
description: test
variables:
  - user.name
template: |
  Hi \${user.name}`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    expect(() => loader.render("needs-var", {})).toThrow(/user\.name/);
  });

  it("8. dotted-path interpolation walks nested objects", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "nested.yaml"),
      `name: nested
description: test
variables:
  - a.b.c
template: |
  Value: \${a.b.c}`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    expect(loader.render("nested", { a: { b: { c: 42 } } }).trim()).toBe("Value: 42");
  });

  it("9. undeclared ${...} patterns pass through literally (escape behavior)", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "shell.yaml"),
      `name: shell
description: test
variables:
  - session
template: |
  Run: gh pr view \${pr_number}
  Session: \${session}`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    const out = loader.render("shell", { session: "ao-1" });
    // ${pr_number} is NOT declared — passes through literally
    expect(out).toContain("gh pr view ${pr_number}");
    expect(out).toContain("Session: ao-1");
  });

  it("10. renderReaction returns correct string for a known key", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "reactions.yaml"),
      `name: reactions
description: test
reactions:
  ci-failed:
    description: test
    variables: []
    template: |
      CI IS BROKEN
  other:
    description: test
    variables: []
    template: |
      OK`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    expect(loader.renderReaction("ci-failed").trim()).toBe("CI IS BROKEN");
  });

  it("11. renderReaction with unknown key throws", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "reactions.yaml"),
      `name: reactions
description: test
reactions:
  known:
    description: test
    variables: []
    template: |
      OK`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    expect(() => loader.renderReaction("unknown")).toThrow(/unknown/);
  });

  it("12. cache: second render of same file does not re-read disk", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "cached.yaml"),
      `name: cached
description: test
variables: []
template: |
  HELLO`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    const spy = vi.spyOn(fs, "readFileSync");
    loader.render("cached", {});
    const firstCalls = spy.mock.calls.length;
    loader.render("cached", {});
    expect(spy.mock.calls.length).toBe(firstCalls); // no additional reads
  });

  it("13. render and renderReaction are synchronous (return string not Promise)", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "sync.yaml"),
      `name: sync
description: test
variables: []
template: |
  OK`,
    );
    const loader = new PromptLoader({ projectDir: tmp });
    const result = loader.render("sync", {});
    expect(typeof result).toBe("string");
    expect(result).not.toBeInstanceOf(Promise);
  });
});
```

- [ ] **Step 2.2: Run tests to see them all fail (expected — loader doesn't exist)**

```bash
pnpm --filter @aoagents/ao-core test -- loader.test
```

Expected: all 13 tests fail with "Cannot find module" or "PromptLoader is not a constructor".

- [ ] **Step 2.3: Write the loader implementation**

Create `packages/core/src/prompts/loader.ts`:

```ts
/**
 * PromptLoader — loads, validates, and renders YAML prompt templates.
 *
 * Lookup order (first hit wins, per-file):
 *   1. <options.promptsDir>/<name>.yaml         (if promptsDir is set)
 *   2. <options.projectDir>/.agent-orchestrator/prompts/<name>.yaml
 *   3. <bundled>/prompts/templates/<name>.yaml  (ships with @aoagents/ao-core)
 *
 * Synchronous by design — file I/O uses readFileSync, yaml parsing is sync.
 * This matches the existing signatures of buildPrompt, generateOrchestratorPrompt,
 * and setupPathWrapperWorkspace, avoiding an async ripple through spawn paths.
 *
 * Interpolation substitutes ONLY keys listed in the template's `variables`
 * field. All other ${...} occurrences pass through literally, which is the
 * escape mechanism for shell examples like `gh pr view ${pr_number}`.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

// =============================================================================
// Schemas
// =============================================================================

const SingleTemplateSchema = z.object({
  name: z.string(),
  description: z.string(),
  variables: z.array(z.string()).default([]),
  template: z.string(),
});

const ReactionEntrySchema = z.object({
  description: z.string(),
  variables: z.array(z.string()).default([]),
  template: z.string(),
});

const ReactionsFileSchema = z.object({
  name: z.literal("reactions"),
  description: z.string(),
  reactions: z.record(ReactionEntrySchema),
});

export type SingleTemplate = z.infer<typeof SingleTemplateSchema>;
export type ReactionsFile = z.infer<typeof ReactionsFileSchema>;

type ParsedTemplate =
  | { kind: "single"; data: SingleTemplate; sourcePath: string }
  | { kind: "reactions"; data: ReactionsFile; sourcePath: string };

// =============================================================================
// Options
// =============================================================================

export interface PromptLoaderOptions {
  /** Absolute path to the project root (used for .agent-orchestrator/prompts lookup). */
  projectDir: string;
  /** Optional explicit override directory from agent-orchestrator.yaml. */
  promptsDir?: string;
}

// =============================================================================
// Bundled template directory resolution
// =============================================================================

// ESM-safe __dirname equivalent. Core is "type": "module"; __dirname doesn't exist.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES_DIR = join(MODULE_DIR, "templates");

// =============================================================================
// Loader
// =============================================================================

export class PromptLoader {
  private readonly projectDir: string;
  private readonly promptsDir?: string;
  private readonly cache = new Map<string, ParsedTemplate>();

  constructor(options: PromptLoaderOptions) {
    if (!isAbsolute(options.projectDir)) {
      throw new Error(
        `PromptLoader: projectDir must be absolute (got: ${options.projectDir})`,
      );
    }
    this.projectDir = options.projectDir;
    if (options.promptsDir !== undefined) {
      this.promptsDir = isAbsolute(options.promptsDir)
        ? options.promptsDir
        : resolve(options.projectDir, options.promptsDir);
    }
  }

  /** Render a single-template file. Throws on any error. */
  render(name: string, vars: Record<string, unknown>): string {
    const parsed = this.load(name);
    if (parsed.kind !== "single") {
      throw new Error(
        `PromptLoader.render: '${name}' is a reactions file; use renderReaction() instead`,
      );
    }
    return interpolate(parsed.data.template, vars, parsed.data.variables, name);
  }

  /** Render one reaction from reactions.yaml. Throws on unknown key. */
  renderReaction(key: string, vars: Record<string, unknown> = {}): string {
    const parsed = this.load("reactions");
    if (parsed.kind !== "reactions") {
      throw new Error(
        `PromptLoader.renderReaction: expected a reactions file, got single template`,
      );
    }
    const entry = parsed.data.reactions[key];
    if (!entry) {
      throw new Error(
        `PromptLoader.renderReaction: unknown reaction key '${key}' in ${parsed.sourcePath}`,
      );
    }
    return interpolate(entry.template, vars, entry.variables, `reactions.${key}`);
  }

  // ------------- internals -------------

  private load(name: string): ParsedTemplate {
    const cached = this.cache.get(name);
    if (cached) return cached;

    const candidates: string[] = [];
    if (this.promptsDir) candidates.push(join(this.promptsDir, `${name}.yaml`));
    candidates.push(join(this.projectDir, ".agent-orchestrator", "prompts", `${name}.yaml`));
    candidates.push(join(BUNDLED_TEMPLATES_DIR, `${name}.yaml`));

    let sourcePath: string | undefined;
    for (const path of candidates) {
      if (existsSync(path)) {
        sourcePath = path;
        break;
      }
    }
    if (!sourcePath) {
      throw new Error(
        `PromptLoader: template '${name}' not found. Checked:\n  ${candidates.join("\n  ")}`,
      );
    }

    let raw: string;
    try {
      raw = readFileSync(sourcePath, "utf-8");
    } catch (err) {
      throw new Error(`PromptLoader: failed to read ${sourcePath}`, { cause: err });
    }

    let yaml: unknown;
    try {
      yaml = parseYaml(raw);
    } catch (err) {
      throw new Error(`PromptLoader: invalid YAML in ${sourcePath}`, { cause: err });
    }

    let parsed: ParsedTemplate;
    if (name === "reactions") {
      const result = ReactionsFileSchema.safeParse(yaml);
      if (!result.success) {
        throw new Error(
          `PromptLoader: schema validation failed for ${sourcePath}\n${result.error.message}`,
        );
      }
      parsed = { kind: "reactions", data: result.data, sourcePath };
    } else {
      const result = SingleTemplateSchema.safeParse(yaml);
      if (!result.success) {
        throw new Error(
          `PromptLoader: schema validation failed for ${sourcePath}\n${result.error.message}`,
        );
      }
      parsed = { kind: "single", data: result.data, sourcePath };
    }

    this.cache.set(name, parsed);
    return parsed;
  }
}

// =============================================================================
// Interpolation
// =============================================================================

/**
 * Substitute declared variables into a template.
 *
 * Contract:
 *   - Every key in `declared` must resolve in `vars` (else throw).
 *   - Each ${key} where key ∈ declared is replaced by the resolved value.
 *   - Each ${key} where key ∉ declared passes through LITERALLY.
 *     This is the escape mechanism for shell examples inside templates.
 */
function interpolate(
  template: string,
  vars: Record<string, unknown>,
  declared: readonly string[],
  templateName: string,
): string {
  // Resolve every declared variable first (fail fast on missing).
  const resolved = new Map<string, string>();
  for (const key of declared) {
    const value = walkDottedPath(vars, key);
    if (value === undefined) {
      throw new Error(
        `PromptLoader: template '${templateName}' requires variable '${key}' but it was not provided`,
      );
    }
    resolved.set(key, String(value));
  }

  // Replace ${<declared-key>} in the template. Keys with dots need escaping
  // in the regex character class; use a simple string split/join per key instead.
  let out = template;
  for (const [key, value] of resolved) {
    // All occurrences of literal "${key}" -> value
    out = out.split("${" + key + "}").join(value);
  }
  return out;
}

function walkDottedPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = root;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
```

- [ ] **Step 2.4: Run the tests again**

```bash
pnpm --filter @aoagents/ao-core test -- loader.test
```

Expected: all 13 tests pass. If tests 1, 2, 5, 9 fail because the loader is being found by the bundled-template lookup (it has a `dist/` from a previous build), that is a false positive — the tests use a `tmp` projectDir and the `.agent-orchestrator/prompts` path under it, so bundled fallback should not kick in. If it does, double-check that `BUNDLED_TEMPLATES_DIR` does not collide with the tmp dir.

- [ ] **Step 2.5: Create the shared test helper**

Create `packages/core/src/__tests__/prompts/fixtures.ts`:

```ts
import { resolve } from "node:path";
import { PromptLoader } from "../../prompts/loader.js";

/**
 * Returns a PromptLoader that reads ONLY from bundled templates — no
 * project-local overrides. Used by tests that want the default output.
 *
 * projectDir is set to a path that definitely has no .agent-orchestrator/prompts
 * directory, so the loader falls through to bundled defaults.
 */
export function createTestPromptLoader(): PromptLoader {
  return new PromptLoader({
    projectDir: resolve("/tmp/__ao_no_project_overrides__"),
  });
}
```

- [ ] **Step 2.6: Typecheck and commit**

```bash
pnpm --filter @aoagents/ao-core typecheck
pnpm --filter @aoagents/ao-core test -- loader.test
git add packages/core/src/prompts/loader.ts packages/core/src/__tests__/prompts/
git commit -m "feat(core): add PromptLoader with lookup chain and declared-only interpolation"
```

---

## Task 3: Public type exports + `promptsDir` config key

**Purpose:** Expose `PromptLoader` from the core public API and add the `promptsDir` key to the orchestrator config schema.

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/config.ts` (just the schema — reaction defaults in Task 7)
- Modify: `packages/core/src/types.ts` (OrchestratorConfig — if `promptsDir` is defined there; otherwise skip)

- [ ] **Step 3.1: Export PromptLoader from core's public API**

Add to `packages/core/src/index.ts` (in the appropriate re-export block):

```ts
export { PromptLoader } from "./prompts/loader.js";
export type { PromptLoaderOptions, SingleTemplate, ReactionsFile } from "./prompts/loader.js";
```

- [ ] **Step 3.2: Add `promptsDir` to the orchestrator config Zod schema**

In `packages/core/src/config.ts`, find the top-level orchestrator config Zod schema (the `z.object(...)` that parses `agent-orchestrator.yaml`). Add:

```ts
promptsDir: z.string().optional(),
```

with a short comment: `/** Optional: directory to search for prompt template overrides. Absolute or relative to the project directory. */`.

Also update the `OrchestratorConfig` TypeScript type (likely auto-inferred via `z.infer`) — no manual change required if it is inferred, but verify by reading the file.

- [ ] **Step 3.3: Typecheck**

```bash
pnpm --filter @aoagents/ao-core typecheck
```

Expected: passes. If it fails because `OrchestratorConfig` is hand-typed and doesn't include `promptsDir`, add it there too.

- [ ] **Step 3.4: Commit**

```bash
git add packages/core/src/index.ts packages/core/src/config.ts packages/core/src/types.ts
git commit -m "feat(core): export PromptLoader and add optional promptsDir config key"
```

---

## Task 4: Extract `BASE_AGENT_PROMPT` → `base-agent.yaml`

**Purpose:** Move Layer 1 of the prompt assembly to a YAML template. Zero behavior change.

**Files:**
- Create: `packages/core/src/prompts/templates/base-agent.yaml`
- Modify: `packages/core/src/prompt-builder.ts`
- Modify: `packages/core/src/__tests__/prompt-builder.test.ts`

- [ ] **Step 4.1: Create the YAML template**

Create `packages/core/src/prompts/templates/base-agent.yaml`. Copy the content of `BASE_AGENT_PROMPT` (currently `prompt-builder.ts:21-40`) verbatim into the `template:` block scalar. Use `|` (keeps final newline). No variables:

```yaml
name: base-agent
description: System instructions for worker agents (Layer 1 of the 3-layer prompt assembly). Covers session lifecycle, git workflow, and PR best practices.
variables: []
template: |
  You are an AI coding agent managed by the Agent Orchestrator (ao).

  ## Session Lifecycle
  - You are running inside a managed session. Focus on the assigned task.
  - When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
  - If you're told to take over or continue work on an existing PR, run `ao session claim-pr <pr-number-or-url>` from inside this session before making changes.
  - If CI fails, the orchestrator will send you the failures — fix them and push again.
  - If reviewers request changes, the orchestrator will forward their comments — address each one, push fixes, and reply to the comments.

  ## Git Workflow
  - Always create a feature branch from the default branch (never commit directly to it).
  - Use conventional commit messages (feat:, fix:, chore:, etc.).
  - Push your branch and create a PR when the implementation is ready.
  - Keep PRs focused — one issue per PR.

  ## PR Best Practices
  - Write a clear PR title and description explaining what changed and why.
  - Link the issue in the PR description so it auto-closes when merged.
  - If the repo has CI checks, make sure they pass before requesting review.
  - Respond to every review comment, even if just to acknowledge it.
```

**Byte-identity note:** The `|` block scalar in YAML includes exactly one trailing newline. The original `BASE_AGENT_PROMPT` is a template literal with NO trailing newline. Task 4 Step 4.4 handles this: `buildPrompt` will call `.replace(/\n$/, "")` on the loader output for the base-agent layer, OR the YAML will use `|-` (strip final newline). Use `|-` to keep the code cleaner.

**Revised:** change the first line from `template: |` to `template: |-`.

- [ ] **Step 4.2: Refactor `buildPrompt` to use the loader**

Edit `packages/core/src/prompt-builder.ts`:

1. Delete the `BASE_AGENT_PROMPT` constant and its `// LAYER 1` comment block.
2. Remove the `export` (no external consumers should exist; verify with a grep first).
3. Import `PromptLoader`:
   ```ts
   import type { PromptLoader } from "./prompts/loader.js";
   ```
4. Add `loader: PromptLoader` to `PromptBuildConfig`:
   ```ts
   export interface PromptBuildConfig {
     loader: PromptLoader;
     project: ProjectConfig;
     projectId: string;
     issueId?: string;
     issueContext?: string;
     userPrompt?: string;
   }
   ```
5. Replace `sections.push(BASE_AGENT_PROMPT);` with:
   ```ts
   sections.push(config.loader.render("base-agent", {}));
   ```

**Verification:** grep for `BASE_AGENT_PROMPT` across the repo. Must return 0 matches after the edit (other than in historical commits).

```bash
```
Use the Grep tool for `BASE_AGENT_PROMPT` across `packages/**/*.ts` — expect 0 results.

- [ ] **Step 4.3: Update prompt-builder tests**

Edit `packages/core/src/__tests__/prompt-builder.test.ts`:

1. Import the test helper at the top:
   ```ts
   import { createTestPromptLoader } from "./prompts/fixtures.js";
   ```
2. At the top of the `describe` (or in a `beforeEach`), create `const loader = createTestPromptLoader();`.
3. In every `buildPrompt({ ... })` call (15 sites per earlier grep), add `loader` as the first field. Example:
   ```ts
   const result = buildPrompt({ loader, project, projectId: "test-app" });
   ```
4. Add a new test at the end of the file that asserts byte-identical output against the golden file captured in Task 0:
   ```ts
   import { readFileSync } from "node:fs";
   import { dirname, join } from "node:path";
   import { fileURLToPath } from "node:url";

   const __dirname = dirname(fileURLToPath(import.meta.url));

   it("matches pre-refactor golden output (minimal buildPrompt)", () => {
     const loader = createTestPromptLoader();
     const project = {
       name: "TestProj",
       repo: "owner/testproj",
       path: "/tmp/testproj",
       defaultBranch: "main",
       sessionPrefix: "tp",
     };
     const result = buildPrompt({ loader, project, projectId: "test" });
     const golden = readFileSync(
       join(__dirname, "prompts", "golden", "base-agent-minimal.txt"),
       "utf-8",
     );
     expect(result).toBe(golden);
   });
   ```

- [ ] **Step 4.4: Build (required — tests need the YAML in dist/)**

```bash
pnpm --filter @aoagents/ao-core build
```

Expected: postbuild script reports `copied 1 files`. Verify:

```bash
ls packages/core/dist/prompts/templates/
```
Use the Bash tool with the `ls` command — should list `base-agent.yaml`.

- [ ] **Step 4.5: Run all core tests**

```bash
pnpm --filter @aoagents/ao-core test
```

Expected: all green, **including** the new golden-match test. If the golden test fails with a whitespace diff, the most likely cause is the `|` vs `|-` block scalar choice. Fix and re-run.

- [ ] **Step 4.6: Commit**

```bash
git add packages/core/src/prompts/templates/base-agent.yaml \
        packages/core/src/prompt-builder.ts \
        packages/core/src/__tests__/prompt-builder.test.ts
git commit -m "refactor(core): extract BASE_AGENT_PROMPT into base-agent.yaml template"
```

---

## Task 5: Extract orchestrator prompt → `orchestrator.yaml`

**Purpose:** Move the ~230-line orchestrator prompt into a template, pre-formatting the two optional sections (`reactions`, `projectRules`) as scalar variables owned by the caller. Zero behavior change.

**Files:**
- Create: `packages/core/src/prompts/templates/orchestrator.yaml`
- Modify: `packages/core/src/orchestrator-prompt.ts`
- Modify: `packages/core/src/__tests__/orchestrator-prompt.test.ts`
- Modify: `packages/cli/src/commands/start.ts` (line ~1064)
- Modify: `packages/web/src/app/api/orchestrators/route.ts` (line ~67)

- [ ] **Step 5.1: Create the YAML template**

Create `packages/core/src/prompts/templates/orchestrator.yaml`. Copy the content of the static sections from `generateOrchestratorPrompt` (the parts that are always present) into a single `|-` block scalar. Replace:

- `${project.name}` → stays as `${project.name}` (declared variable)
- `${project.repo}` → stays (declared)
- `${project.defaultBranch}` → stays (declared)
- `${project.sessionPrefix}` → stays (declared)
- `${project.path}` → stays (declared — it is used in the "Local Path" line of "Project Info")
- `${config.port ?? 3000}` → becomes `${config.port}` (declared). The JS fallback `?? 3000` is pre-resolved by the caller (see Step 5.2).
- `${projectId}` → stays (declared)

After the `## Dashboard` section (where the current code conditionally appends the "Automated Reactions" block via `if (project.reactions && ...) { sections.push(...) }`), place `${reactionsSection}`.

After the `## Tips` section (where the current code conditionally appends the "Project-Specific Rules" block), place `${projectRulesSection}`.

**The `${reactionsSection}` and `${projectRulesSection}` placeholders MUST sit flush against adjacent content in the YAML** — no surrounding `\n\n`. The caller supplies the leading `\n\n` inside the returned string (or the empty string when the section is absent). This is how byte-identity with the current `sections.join("\n\n")` is preserved.

Schema:

```yaml
name: orchestrator
description: System prompt for the orchestrator agent managing worker sessions
variables:
  - project.name
  - project.repo
  - project.defaultBranch
  - project.sessionPrefix
  - project.path
  - config.port
  - projectId
  - reactionsSection
  - projectRulesSection
template: |-
  # ${project.name} Orchestrator

  You are the **orchestrator agent** for the ${project.name} project.

  ... <full body of all always-present sections, joined with literal blank lines> ...

  ## Tips

  1. **Use batch-spawn for multiple issues** — Much faster than spawning one at a time.
  ... etc ...
  ${reactionsSection}${projectRulesSection}
```

**Authoring tip:** the easiest way to get this right is to copy the runtime output of `generateOrchestratorPrompt` for a "no reactions, no projectRules" fixture (the `orchestrator-none-no-rules.txt` golden from Task 0) as the starting template body, then swap the interpolated values back to `${...}` placeholders and append the two empty-string placeholders at the end.

**Block scalar chomping:** use `|-` to strip the trailing newline (since the current function returns `sections.join("\n\n")` with no trailing newline).

- [ ] **Step 5.2: Refactor `generateOrchestratorPrompt`**

Edit `packages/core/src/orchestrator-prompt.ts`:

1. Import `PromptLoader`:
   ```ts
   import type { PromptLoader } from "./prompts/loader.js";
   ```
2. Add `loader: PromptLoader` to `OrchestratorPromptConfig`:
   ```ts
   export interface OrchestratorPromptConfig {
     loader: PromptLoader;
     config: OrchestratorConfig;
     projectId: string;
     project: ProjectConfig;
   }
   ```
3. Replace the body of `generateOrchestratorPrompt` with:
   ```ts
   export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
     const { loader, config, projectId, project } = opts;

     // Pre-format the two optional sections into scalars. The function, NOT the
     // template, owns the leading "\n\n" — this is what keeps output byte-identical
     // with the previous sections.join("\n\n") approach.
     const reactionsSection = buildReactionsSection(project);
     const projectRulesSection = buildProjectRulesSection(project);

     return loader.render("orchestrator", {
       project: {
         name: project.name,
         repo: project.repo,
         defaultBranch: project.defaultBranch,
         sessionPrefix: project.sessionPrefix,
         path: project.path,
       },
       config: {
         port: config.port ?? 3000,
       },
       projectId,
       reactionsSection,
       projectRulesSection,
     });
   }

   /** Build the "Automated Reactions" section as a scalar, or empty if no reactions. */
   function buildReactionsSection(project: ProjectConfig): string {
     if (!project.reactions || Object.keys(project.reactions).length === 0) return "";
     const lines: string[] = [];
     for (const [event, reaction] of Object.entries(project.reactions)) {
       if (reaction.auto && reaction.action === "send-to-agent") {
         lines.push(
           `- **${event}**: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
         );
       } else if (reaction.auto && reaction.action === "notify") {
         lines.push(`- **${event}**: Notifies human (priority: ${reaction.priority ?? "info"})`);
       }
     }
     if (lines.length === 0) return "";
     // Owns the leading \n\n so the template placeholder can sit flush.
     return `\n\n## Automated Reactions

The system automatically handles these events:

${lines.join("\n")}`;
   }

   /** Build the "Project-Specific Rules" section as a scalar, or empty if unset. */
   function buildProjectRulesSection(project: ProjectConfig): string {
     if (!project.orchestratorRules) return "";
     return `\n\n## Project-Specific Rules

${project.orchestratorRules}`;
   }
   ```

**Important:** the `sections` local variable and the `sections.push(...)` calls are deleted. Everything that was in the sections array now lives in `orchestrator.yaml`.

- [ ] **Step 5.3: Update the two external callers**

`packages/cli/src/commands/start.ts:1064`:

Change:
```ts
const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
```

to:
```ts
const systemPrompt = generateOrchestratorPrompt({ loader: promptLoader, config, projectId, project });
```

The `promptLoader` variable must be constructed earlier in `start.ts` (search for where `config` is first loaded, then construct `new PromptLoader({ projectDir: project.path, promptsDir: config.promptsDir })`). If `start.ts` doesn't yet have access to `PromptLoader`, add the import:
```ts
import { PromptLoader } from "@aoagents/ao-core";
```

Same change in `packages/web/src/app/api/orchestrators/route.ts:67`.

- [ ] **Step 5.4: Update orchestrator-prompt tests with 8-fixture cartesian**

Edit `packages/core/src/__tests__/orchestrator-prompt.test.ts`:

1. Import the test helper.
2. Update the existing 3 tests to pass `loader: createTestPromptLoader()`.
3. Add 8 golden-match tests covering the `reactions × rules` matrix:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestPromptLoader } from "./prompts/fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(__dirname, "prompts", "golden");

const baseProject = {
  name: "TestProj",
  repo: "owner/testproj",
  path: "/tmp/testproj",
  defaultBranch: "main",
  sessionPrefix: "tp",
};
const reactionsCases = {
  none: undefined,
  "send-to-agent": {
    "ci-failed": { auto: true, action: "send-to-agent" as const, retries: 2, escalateAfter: 2 },
  },
  notify: {
    "approved-and-green": { auto: true, action: "notify" as const, priority: "action" as const },
  },
  mixed: {
    "ci-failed": { auto: true, action: "send-to-agent" as const },
    "approved-and-green": { auto: true, action: "notify" as const, priority: "info" as const },
  },
};
const rulesCases = {
  "no-rules": undefined,
  "with-rules": "Be extra careful with database migrations.",
};

for (const [rk, reactions] of Object.entries(reactionsCases)) {
  for (const [pk, orchestratorRules] of Object.entries(rulesCases)) {
    it(`matches golden orchestrator-${rk}-${pk}`, () => {
      const loader = createTestPromptLoader();
      const prompt = generateOrchestratorPrompt({
        loader,
        config: { port: 3000 },
        projectId: "test",
        project: { ...baseProject, reactions, orchestratorRules },
      });
      const golden = readFileSync(join(goldenDir, `orchestrator-${rk}-${pk}.txt`), "utf-8");
      expect(prompt).toBe(golden);
    });
  }
}
```

- [ ] **Step 5.5: Build and run tests**

```bash
pnpm --filter @aoagents/ao-core build
pnpm --filter @aoagents/ao-core test
```

Expected: all 8 golden tests pass. If any fail with a whitespace diff, read the diff carefully — most likely causes:
1. A trailing newline on the `|` block scalar (use `|-`).
2. The `${reactionsSection}`/`${projectRulesSection}` placeholder has surrounding whitespace in the YAML — it should sit flush.
3. A section boundary in the YAML is using a single `\n` instead of `\n\n` (block scalars preserve newlines literally, so the YAML body must contain literal blank lines between sections).

- [ ] **Step 5.6: Typecheck the CLI and web packages**

```bash
pnpm --filter @aoagents/ao-cli typecheck
pnpm --filter @aoagents/ao-web typecheck
```

Expected: pass. Fix any remaining `generateOrchestratorPrompt` call sites.

- [ ] **Step 5.7: Commit**

```bash
git add packages/core/src/prompts/templates/orchestrator.yaml \
        packages/core/src/orchestrator-prompt.ts \
        packages/core/src/__tests__/orchestrator-prompt.test.ts \
        packages/cli/src/commands/start.ts \
        packages/web/src/app/api/orchestrators/route.ts
git commit -m "refactor(core): extract generateOrchestratorPrompt body into orchestrator.yaml"
```

---

## Task 6: Extract CI failure formatter → `ci-failure.yaml`

**Files:**
- Create: `packages/core/src/prompts/templates/ci-failure.yaml`
- Modify: `packages/core/src/lifecycle-manager.ts`

- [ ] **Step 6.1: Create the YAML template**

`packages/core/src/prompts/templates/ci-failure.yaml`:

```yaml
name: ci-failure
description: Message sent to an agent when CI checks fail on their PR. The caller pre-formats the failed checks list as a single scalar.
variables:
  - failedChecksList
template: |-
  CI checks are failing on your PR. Here are the failed checks:

  ${failedChecksList}

  Investigate the failures, fix the issues, and push again.
```

- [ ] **Step 6.2: Refactor `formatCIFailureMessage`**

`formatCIFailureMessage` is a nested function inside `createLifecycleManager` (which receives `deps: LifecycleManagerDeps`). Add `promptLoader: PromptLoader` to `LifecycleManagerDeps`:

```ts
import type { PromptLoader } from "./prompts/loader.js";

export interface LifecycleManagerDeps {
  // ... existing fields
  promptLoader: PromptLoader;
}
```

Then rewrite `formatCIFailureMessage` (currently lines 932-947):

```ts
function formatCIFailureMessage(failedChecks: CICheck[]): string {
  const failedChecksList = failedChecks
    .map((check) => {
      const status = check.conclusion ?? check.status;
      const link = check.url ? ` — ${check.url}` : "";
      return `- **${check.name}**: ${status}${link}`;
    })
    .join("\n");
  return deps.promptLoader.render("ci-failure", { failedChecksList });
}
```

(Uses `deps.promptLoader` since this function is a closure inside `createLifecycleManager`.)

- [ ] **Step 6.3: Build and test**

```bash
pnpm --filter @aoagents/ao-core build
pnpm --filter @aoagents/ao-core test
```

Expected: core tests pass. Any test that constructs a `LifecycleManager` via `createLifecycleManager` must now also provide `promptLoader` — the typecheck will surface these. Fix by passing `createTestPromptLoader()`.

- [ ] **Step 6.4: Commit**

```bash
git add packages/core/src/prompts/templates/ci-failure.yaml \
        packages/core/src/lifecycle-manager.ts \
        packages/core/src/__tests__/
git commit -m "refactor(core): extract CI failure message template"
```

---

## Task 7: Extract reaction messages → `reactions.yaml`

**Files:**
- Create: `packages/core/src/prompts/templates/reactions.yaml`
- Modify: `packages/core/src/config.ts` (`applyDefaultReactions`)
- Modify: tests that assert reaction defaults

- [ ] **Step 7.1: Create the YAML template**

`packages/core/src/prompts/templates/reactions.yaml`:

```yaml
name: reactions
description: Default messages sent to agents during lifecycle transitions. Other reaction fields (auto, action, retries, escalateAfter, priority, threshold) stay in core config.ts — only message strings live here.
reactions:
  ci-failed:
    description: Sent when CI is failing on the agent's PR.
    variables: []
    template: |-
      CI is failing on your PR. Run `gh pr checks` to see the failures, fix them, and push.
  changes-requested:
    description: Sent when a reviewer has requested changes.
    variables: []
    template: |-
      There are review comments on your PR. Check with `gh pr view --comments` and `gh api` for inline comments. Address each one, push fixes, and reply.
  bugbot-comments:
    description: Sent when automated review comments are found.
    variables: []
    template: |-
      Automated review comments found on your PR. Fix the issues flagged by the bot.
  merge-conflicts:
    description: Sent when the PR branch has merge conflicts.
    variables: []
    template: |-
      Your branch has merge conflicts. Rebase on the default branch and resolve them.
  approved-and-green:
    description: Notification message when the PR is ready to merge.
    variables: []
    template: |-
      PR is ready to merge
  agent-idle:
    description: Sent when an agent has been idle and may need a nudge.
    variables: []
    template: |-
      You appear to be idle. If your task is not complete, continue working — write the code, commit, push, and create a PR. If you are blocked, explain what is blocking you.
```

**Critical:** every `template` value MUST exactly match the original message string in `config.ts:538-602` — character for character, including spelling and punctuation. Copy-paste, do not retype.

- [ ] **Step 7.2: Refactor `applyDefaultReactions`**

In `packages/core/src/config.ts`, change the signature:

```ts
function applyDefaultReactions(
  config: OrchestratorConfig,
  promptLoader: PromptLoader,
): OrchestratorConfig {
```

Replace each `message: "..."` string literal in the 6 message-carrying entries with a call to `promptLoader.renderReaction(key)`:

```ts
"ci-failed": {
  auto: true,
  action: "send-to-agent",
  message: promptLoader.renderReaction("ci-failed"),
  retries: 2,
  escalateAfter: 2,
},
// ... same pattern for changes-requested, bugbot-comments, merge-conflicts,
// approved-and-green, agent-idle ...
```

The other 5 entries (`agent-stuck`, `agent-needs-input`, `agent-exited`, `all-complete`, and any non-message fields) are unchanged.

Update the caller of `applyDefaultReactions` (search for it — likely `loadConfig` or `parseConfig` in the same file) to construct a loader and pass it:

```ts
const promptLoader = new PromptLoader({
  projectDir: /* the dir containing agent-orchestrator.yaml */,
  promptsDir: config.promptsDir,
});
return applyDefaultReactions(config, promptLoader);
```

**Decision on `projectDir` for the config-scoped loader:** the orchestrator config is loaded from a specific file path (e.g., `/Users/vitor/project/agent-orchestrator.yaml`). Use `dirname(configFilePath)` as the `projectDir`. This is NOT per-project in the multi-project sense — it is the directory containing the config file. That IS where a user would put `.agent-orchestrator/prompts/` to override the reaction defaults.

- [ ] **Step 7.3: Update tests**

Any test that calls `applyDefaultReactions` directly (search the codebase) must now pass a `PromptLoader`. Use `createTestPromptLoader()`.

Add a test that verifies:
- When user YAML omits `reactions`, all 6 default messages match the strings in `reactions.yaml`.
- When user YAML sets `reactions.ci-failed.message = "custom"`, the user value wins.
- Non-message fields (`auto`, `retries`, etc.) are unchanged.

- [ ] **Step 7.4: Build and test**

```bash
pnpm --filter @aoagents/ao-core build
pnpm --filter @aoagents/ao-core test
```

Expected: all green.

- [ ] **Step 7.5: Commit**

```bash
git add packages/core/src/prompts/templates/reactions.yaml \
        packages/core/src/config.ts \
        packages/core/src/__tests__/
git commit -m "refactor(core): extract default reaction messages into reactions.yaml"
```

---

## Task 8: Extract `.ao/AGENTS.md` blurb → `agent-workspace.yaml` + module-level loader

**Files:**
- Create: `packages/core/src/prompts/templates/agent-workspace.yaml`
- Modify: `packages/core/src/agent-workspace-hooks.ts`

- [ ] **Step 8.1: Create the YAML template**

`packages/core/src/prompts/templates/agent-workspace.yaml`:

```yaml
name: agent-workspace
description: Section appended to .ao/AGENTS.md inside each managed workspace. Explains the metadata update fallback for PATH-wrapper agents.
variables: []
template: |2

  ## Agent Orchestrator (ao) Session

  You are running inside an Agent Orchestrator managed workspace.
  Session metadata is updated automatically via shell wrappers.

  If automatic updates fail, you can manually update metadata:
  ```bash
  ~/.ao/bin/ao-metadata-helper.sh  # sourced automatically
  # Then call: update_ao_metadata <key> <value>
  ```
```

Note the `|2` indicator: this preserves the leading blank line that the current `AO_AGENTS_MD_SECTION` constant starts with (it begins with `\n## Agent Orchestrator...`). If the leading `\n` is wrong for your setup, use `|` or `|-` as appropriate — verify against the current constant.

**Verification:** print the current constant and compare:

Use the Read tool on `packages/core/src/agent-workspace-hooks.ts:267-278` and confirm the literal newlines.

- [ ] **Step 8.2: Replace `AO_AGENTS_MD_SECTION` with a lazy module-level loader**

In `packages/core/src/agent-workspace-hooks.ts`:

1. Delete the `export const AO_AGENTS_MD_SECTION = ...` declaration (lines ~262-278).
2. Add a lazy getter at the top of the file (after imports):
   ```ts
   import { PromptLoader } from "./prompts/loader.js";

   let cachedAgentWorkspaceSection: string | null = null;

   function getAgentWorkspaceSection(workspacePath: string): string {
     if (cachedAgentWorkspaceSection !== null) return cachedAgentWorkspaceSection;
     // projectDir is the workspace path — this allows a user to drop a
     // .agent-orchestrator/prompts/agent-workspace.yaml into their workspace
     // root to override the default. promptsDir is intentionally omitted;
     // this code path doesn't have a config object in scope.
     const loader = new PromptLoader({ projectDir: workspacePath });
     cachedAgentWorkspaceSection = loader.render("agent-workspace", {});
     return cachedAgentWorkspaceSection;
   }
   ```
3. Replace every reference to `AO_AGENTS_MD_SECTION` in this file with `getAgentWorkspaceSection(workspacePath)` where `workspacePath` is in scope (which it should be, since this is a hook that runs per-workspace).

**Cache note:** the module-level cache means different workspaces will see the same content after the first call. Since `agent-workspace.yaml` has no variables and the bundled default is always the same, this is correct as long as no workspace has a different project-local override. This is an acceptable trade-off (documented in the spec).

- [ ] **Step 8.3: Grep for remaining references**

```bash
```
Use the Grep tool for `AO_AGENTS_MD_SECTION` across all files — expect 0 matches after the refactor.

- [ ] **Step 8.4: Build and test**

```bash
pnpm --filter @aoagents/ao-core build
pnpm --filter @aoagents/ao-core test
```

Expected: all green. Any existing test of `agent-workspace-hooks` that referenced `AO_AGENTS_MD_SECTION` should now call `getAgentWorkspaceSection(...)` or check the on-disk `AGENTS.md` contents.

- [ ] **Step 8.5: Commit**

```bash
git add packages/core/src/prompts/templates/agent-workspace.yaml \
        packages/core/src/agent-workspace-hooks.ts
git commit -m "refactor(core): extract .ao/AGENTS.md blurb into agent-workspace.yaml"
```

---

## Task 9: Thread `PromptLoader` through `SessionManagerDeps` and callers

**Purpose:** Wire the loader into the spawn path. This is the last wiring task before full end-to-end.

**Files:**
- Modify: `packages/core/src/session-manager.ts`
- Modify: `packages/cli/src/lib/create-session-manager.ts`
- Modify: `packages/web/src/lib/services.ts`
- Modify: `packages/core/src/__tests__/session-manager/spawn.test.ts` (and any other spawn tests)

- [ ] **Step 9.1: Add `promptLoaderFactory` to `SessionManagerDeps`**

In `packages/core/src/session-manager.ts`:

```ts
import { PromptLoader } from "./prompts/loader.js";

export interface SessionManagerDeps {
  // ... existing fields
  /**
   * Optional factory for per-project PromptLoader instances. If omitted,
   * a default factory constructs a new PromptLoader for each project using
   * the global `config.promptsDir` override.
   */
  promptLoaderFactory?: (projectDir: string) => PromptLoader;
}
```

Inside `createSessionManager`, after destructuring deps:

```ts
const promptLoaderFactory =
  deps.promptLoaderFactory ??
  ((projectDir: string) =>
    new PromptLoader({ projectDir, promptsDir: deps.config.promptsDir }));

const promptLoaderCache = new Map<string, PromptLoader>();
function getPromptLoader(projectDir: string): PromptLoader {
  let loader = promptLoaderCache.get(projectDir);
  if (!loader) {
    loader = promptLoaderFactory(projectDir);
    promptLoaderCache.set(projectDir, loader);
  }
  return loader;
}
```

In the `spawn` method (at line ~1065), use the loader:

```ts
const composedPrompt = buildPrompt({
  loader: getPromptLoader(project.path),
  project,
  projectId: spawnConfig.projectId,
  issueId: spawnConfig.issueId,
  issueContext,
  userPrompt: spawnConfig.prompt,
});
```

- [ ] **Step 9.2: Update the lifecycle manager construction site**

Find where `createLifecycleManager` is called from inside `createSessionManager` (or wherever it is wired up — typically in the session manager's own constructor or in the CLI/web bootstrap). Pass `promptLoader: getPromptLoader(/* first project path */)` or, preferably, construct a dedicated loader for the lifecycle manager.

**Trade-off note:** the lifecycle manager spans multiple projects, so a single `promptLoader` in its deps is not ideal. Simplest correct approach: for `ci-failure` (the one template it loads), project-local overrides via the config-scoped loader are sufficient. Construct the lifecycle manager's loader from the config directory (same pattern as Task 7 for `applyDefaultReactions`). The `ci-failure` template has no per-project semantics.

If the lifecycle manager construction site doesn't have a `projectDir` handy, use the config file directory:

```ts
const lifecyclePromptLoader = new PromptLoader({
  projectDir: dirname(configFilePath),
  promptsDir: config.promptsDir,
});
```

- [ ] **Step 9.3: Update CLI and web wiring**

`packages/cli/src/lib/create-session-manager.ts`: no functional change required if the default factory works. Just ensure the call site still typechecks.

`packages/web/src/lib/services.ts`: same.

- [ ] **Step 9.4: Update spawn tests**

`packages/core/src/__tests__/session-manager/spawn.test.ts` (and any sibling spawn tests): if they construct `SessionManager` via `createSessionManager({ config, registry })`, the default factory handles everything — no test changes needed. If they stub out the prompt builder or use custom deps, inject `promptLoaderFactory: () => createTestPromptLoader()`.

- [ ] **Step 9.5: Full typecheck + test**

```bash
pnpm --filter @aoagents/ao-core typecheck
pnpm --filter @aoagents/ao-core test
pnpm --filter @aoagents/ao-cli typecheck
pnpm --filter @aoagents/ao-web typecheck
```

Expected: all green.

- [ ] **Step 9.6: Commit**

```bash
git add packages/core/src/session-manager.ts \
        packages/cli/src/lib/create-session-manager.ts \
        packages/web/src/lib/services.ts \
        packages/core/src/__tests__/session-manager/
git commit -m "feat(core): wire PromptLoader factory through SessionManagerDeps"
```

---

## Task 10: Document `promptsDir` in `agent-orchestrator.yaml.example`

**Files:**
- Modify: `agent-orchestrator.yaml.example`

- [ ] **Step 10.1: Add the documented key**

Edit `agent-orchestrator.yaml.example`. Find an appropriate top-level section (near other global options). Add:

```yaml
# Optional: directory to search for prompt template overrides.
#
# The PromptLoader looks up templates in this order (first hit wins):
#   1. <promptsDir>/<name>.yaml                                  (this key, if set)
#   2. <projectDir>/.agent-orchestrator/prompts/<name>.yaml      (convention)
#   3. Bundled defaults shipped with @aoagents/ao-core
#
# Paths are absolute or relative to the directory containing this config file.
# Templates available: base-agent, orchestrator, reactions, ci-failure, agent-workspace.
# promptsDir: ./my-custom-prompts
```

- [ ] **Step 10.2: Commit**

```bash
git add agent-orchestrator.yaml.example
git commit -m "docs(config): document promptsDir override in agent-orchestrator.yaml.example"
```

---

## Task 11: Full validation

- [ ] **Step 11.1: Clean build everything**

```bash
pnpm build
```

Expected: succeeds. Postbuild reports `copied 5 files → .../dist/prompts/templates`.

- [ ] **Step 11.2: Full typecheck**

```bash
pnpm typecheck
```

Expected: zero errors across all packages.

- [ ] **Step 11.3: Full test suite**

```bash
pnpm test
```

Expected: all tests pass. Pay special attention to:
- `prompt-builder.test.ts` — 1 new golden test
- `orchestrator-prompt.test.ts` — 8 new golden tests
- `loader.test.ts` — 13 unit tests
- any spawn/session-manager tests that now use `promptLoaderFactory`

- [ ] **Step 11.4: Lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 11.5: Manual smoke test (optional but recommended)**

If you have a local `agent-orchestrator.yaml`:

```bash
```
Use the Bash tool to run `pnpm --filter @aoagents/ao-cli start dashboard` and verify the orchestrator prompt is assembled correctly. Then tail the session manager logs while spawning a test session and verify the worker prompt contains the `BASE_AGENT_PROMPT` content. No functional difference from before; a smoke test just validates that the loader is actually being called and not silently bypassed.

- [ ] **Step 11.6: Final commit / PR opening**

At this point the branch should have ~11 clean commits. Open a PR against `main` with a summary linking to the spec and listing the 5 extracted prompts. Use @superpowers:requesting-code-review to trigger the code review skill if available.

---

## Rollback

If any stage fails catastrophically:

1. `git reset --hard HEAD~N` to the last green commit.
2. The refactor is purely additive until Task 4 — Tasks 0-3 can stay even if later tasks are deferred.
3. The spec and plan documents are independently useful and can remain on the branch even if the implementation is postponed.

## Out of scope reminders (from the spec)

- Hot-reload of templates
- Template composition / `include`
- Looping or conditionals inside templates
- Moving non-message reaction defaults
- Any other string constants in core that aren't LLM prompts

Do not let scope creep during implementation. If you spot a clean-up opportunity, file it as a follow-up.

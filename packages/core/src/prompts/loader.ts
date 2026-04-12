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

import { existsSync, readFileSync } from "node:fs";
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
// Bundled template directory resolution (ESM-safe)
// =============================================================================

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES_DIRS = [
  join(MODULE_DIR, "templates"),
  resolve(MODULE_DIR, "../../src/prompts/templates"),
];

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

  /** Number of templates currently cached (exposed for testing). */
  get _cacheSize(): number {
    return this.cache.size;
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
    candidates.push(
      join(this.projectDir, ".agent-orchestrator", "prompts", `${name}.yaml`),
    );
    for (const bundledDir of BUNDLED_TEMPLATES_DIRS) {
      candidates.push(join(bundledDir, `${name}.yaml`));
    }

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

function interpolate(
  template: string,
  vars: Record<string, unknown>,
  declared: readonly string[],
  templateName: string,
): string {
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

  let out = template;
  for (const [key, value] of resolved) {
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

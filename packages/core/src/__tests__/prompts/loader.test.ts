import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PromptLoader } from "../../prompts/loader.js";

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `prompt-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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

  it("1. loads and renders a project-local template with variables", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
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

    const loader = new PromptLoader({ projectDir: tmp });
    const out = loader.render("greet", { user: { name: "Alice" } });
    expect(out.trim()).toBe("Hello, Alice!");
  });

  it("2. project-local override wins over bundled default lookup fallback", () => {
    const promptsDir = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "base-agent.yaml"),
      `name: base-agent
description: override
variables: []
template: |
  OVERRIDE_MARKER`,
    );

    const loader = new PromptLoader({ projectDir: tmp });
    const out = loader.render("base-agent", {});
    expect(out.trim()).toBe("OVERRIDE_MARKER");
  });

  it("3. explicit promptsDir wins over project-local", () => {
    const projectLocal = join(tmp, ".agent-orchestrator", "prompts");
    mkdirSync(projectLocal, { recursive: true });
    writeFileSync(
      join(projectLocal, "greet.yaml"),
      `name: greet
description: project-local
variables: []
template: |
  PROJECT_LOCAL`,
    );
    const explicit = join(tmp, "custom");
    mkdirSync(explicit, { recursive: true });
    writeFileSync(
      join(explicit, "greet.yaml"),
      `name: greet
description: explicit
variables: []
template: |
  EXPLICIT`,
    );

    const loader = new PromptLoader({ projectDir: tmp, promptsDir: explicit });
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
    writeFileSync(
      join(promptsDir, "bad.yaml"),
      `name: bad\n# missing description and template`,
    );
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

  it("9. undeclared \${...} patterns pass through literally (escape behavior)", () => {
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
    expect(out).toContain("gh pr view \${pr_number}");
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
    // Cache is empty before first render
    expect(loader._cacheSize).toBe(0);
    loader.render("cached", {});
    // Cache has one entry after first render
    expect(loader._cacheSize).toBe(1);
    // Mutate the file on disk to verify second render still returns cached result
    writeFileSync(join(promptsDir, "cached.yaml"), `name: cached\ndescription: test\nvariables: []\ntemplate: |\n  MUTATED`);
    const result = loader.render("cached", {});
    // Still returns original cached value, not the mutated file
    expect(result.trim()).toBe("HELLO");
    expect(loader._cacheSize).toBe(1);
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

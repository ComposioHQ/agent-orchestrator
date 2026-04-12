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

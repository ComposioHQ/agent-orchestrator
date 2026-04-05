/**
 * Artifact Prompt Layer — Layer 5 in the prompt builder pipeline.
 *
 * Tells agents about artifact CLI commands and provides a summary of
 * existing artifacts so they know what's available to discover.
 */

export interface ArtifactContext {
  /** Absolute path to the artifacts directory */
  artifactsDir: string;
  /** Total number of artifacts across all sessions */
  totalArtifacts: number;
}

/**
 * Build the artifact layer (Layer 5) for agent prompts.
 * Injected into buildPrompt() when artifacts are initialized for the project.
 */
export function buildArtifactLayer(ctx: ArtifactContext): string {
  const lines: string[] = [];

  lines.push("## Artifacts");
  lines.push("");
  lines.push(
    "You can publish output artifacts that persist across sessions.",
  );
  lines.push(
    "Other agents and the orchestrator can discover and read them.",
  );

  if (ctx.totalArtifacts > 0) {
    lines.push("");
    lines.push(
      `There are currently ${ctx.totalArtifacts} artifact${ctx.totalArtifacts !== 1 ? "s" : ""}. Run \`ao artifact list\` to see them.`,
    );
  }

  lines.push("");
  lines.push("### Publish Commands");
  lines.push("");
  lines.push("- `ao artifact publish <file> --category <cat>`");
  lines.push(
    "  Publish a file as an artifact. Categories: pr, document, test-report, screenshot, log, other.",
  );
  lines.push(
    "  Add --description for discoverability. Session and issue are auto-detected from environment.",
  );

  lines.push("");
  lines.push("### Discovery Commands");
  lines.push("");
  lines.push(
    "- `ao artifact list [--session <id>] [--issue <id>] [--category <cat>]`",
  );
  lines.push("- `ao artifact grep <pattern>` — Search across all text-based artifacts");
  lines.push("- `ao artifact read <id>` — Read a specific artifact");

  lines.push("");
  lines.push("### What to Publish");
  lines.push("");
  lines.push(
    "Publish anything that others should see or that future sessions might need:",
  );
  lines.push("- Design docs, research findings, decision rationale");
  lines.push("- Test reports, coverage data");
  lines.push("- Screenshots, recordings");
  lines.push("- Gotchas and lessons learned (write a findings doc, publish it)");

  return lines.join("\n");
}

/**
 * Build the artifact section for the orchestrator prompt.
 * Appended to generateOrchestratorPrompt() when artifacts are initialized.
 */
export function buildOrchestratorArtifactSection(): string {
  return `## Session Artifacts

Agents publish their outputs as artifacts. Use these to verify work and plan next steps:

- \`ao artifact list [--session <id>] [--issue <id>] [--category <cat>]\` — List published artifacts
- \`ao artifact grep <pattern>\` — Search across artifact content
- \`ao artifact read <id>\` — Read artifact content
- \`ao artifact summary [--session <id>]\` — One-line summary of artifact state
- \`ao artifact stats\` — Show counts and sizes`;
}

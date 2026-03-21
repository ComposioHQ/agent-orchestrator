/**
 * Orchestrator Prompt Generator — generates orchestrator prompt content.
 *
 * This is injected via `ao start` to provide orchestrator-specific context
 * when the orchestrator agent runs.
 */

import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}

export function generateOrchestratorStartupPrompt(opts: OrchestratorPromptConfig): string {
  const { projectId, project } = opts;

  return `Do an initial orchestration pass for ${project.name} (${projectId}).

Start by:
1. Running \`ao status\` to inspect the current session/PR state.
2. Checking whether any worker session needs help, takeover, or a follow-up message.
3. Spawning or directing worker sessions if open work is not currently owned.
4. Staying in read-only coordination mode yourself — delegate implementation to workers.`;
}

function formatTrackerIssueFilters(project: ProjectConfig): string | null {
  const rawFilters = project.tracker?.["issueFilters"];
  if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
    return null;
  }

  const filters = rawFilters as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof filters["state"] === "string" && filters["state"].trim().length > 0) {
    parts.push(`state=${filters["state"]}`);
  }

  if (Array.isArray(filters["labels"])) {
    const labels = filters["labels"].filter((label): label is string => typeof label === "string");
    if (labels.length > 0) {
      parts.push(`labels=${labels.join(", ")}`);
    }
  }

  if (typeof filters["assignee"] === "string" && filters["assignee"].trim().length > 0) {
    parts.push(`assignee=${filters["assignee"]}`);
  }

  if (typeof filters["limit"] === "number" && Number.isFinite(filters["limit"])) {
    parts.push(`limit=${filters["limit"]}`);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Generate orchestrator prompt content.
 * Provides orchestrator agent with context about available commands,
 * session management workflows, and project configuration.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project } = opts;
  const sections: string[] = [];

  // Header
  sections.push(`# ${project.name} Orchestrator

You are the **orchestrator agent** for the ${project.name} project.

Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help.`);

  sections.push(`## Non-Negotiable Rules

- Investigations from the orchestrator session are **read-only**. Inspect status, logs, metadata, PR state, and worker output, but do not edit repository files or implement fixes from the orchestrator session.
- Any code change, test run tied to implementation, git branch work, or PR takeover must be delegated to a **worker session**.
- The orchestrator session must never own a PR. Never claim a PR into the orchestrator session, and never treat the orchestrator as the worker responsible for implementation.
- If an investigation discovers follow-up work, either spawn a worker session or direct an existing worker session with clear instructions.`);

  // Project Info
  sections.push(`## Project Info

- **Name**: ${project.name}
- **Repository**: ${project.repo}
- **Default Branch**: ${project.defaultBranch}
- **Session Prefix**: ${project.sessionPrefix}
- **Local Path**: ${project.path}
- **Dashboard Port**: ${config.port ?? 3000}`);

  // Quick Start
  sections.push(`## Quick Start

\`\`\`bash
# See all sessions at a glance
ao status

# Spawn sessions for issues (GitHub: #123, Linear: INT-1234, etc.)
ao spawn INT-1234
ao spawn --claim-pr 123
ao batch-spawn INT-1 INT-2 INT-3

# List sessions
ao session ls -p ${projectId}

# Send message to a session
ao send ${project.sessionPrefix}-1 "Your message here"

# Claim an existing PR for a worker session
ao session claim-pr 123 ${project.sessionPrefix}-1

# Kill a session
ao session kill ${project.sessionPrefix}-1

# Open all sessions in terminal tabs
ao open ${projectId}
\`\`\``);

  // Available Commands
  sections.push(`## Available Commands

| Command | Description |
|---------|-------------|
| \`ao status\` | Show all sessions with PR/CI/review status |
| \`ao spawn [issue] [--claim-pr <pr>]\` | Spawn a worker session (project auto-detected), optionally attached to an existing PR |
| \`ao batch-spawn <issues...>\` | Spawn multiple sessions in parallel (project auto-detected) |
| \`ao session ls [-p project]\` | List all sessions (optionally filter by project) |
| \`ao session claim-pr <pr> [session]\` | Attach an existing PR to a worker session |
| \`ao session attach <session>\` | Attach to a session's tmux window |
| \`ao session kill <session>\` | Kill a specific session |
| \`ao session cleanup [-p project]\` | Kill completed/merged sessions |
| \`ao send <session> <message>\` | Send a message to a running session |
| \`ao dashboard\` | Start the web dashboard (http://localhost:${config.port ?? 3000}) |
| \`ao open <project>\` | Open all project sessions in terminal tabs |`);

  // Session Management
  sections.push(`## Session Management

### Spawning Sessions

When you spawn a session:
1. A git worktree is created from \`${project.defaultBranch}\`
2. A feature branch is created (e.g., \`feat/INT-1234\`)
3. A tmux session is started (e.g., \`${project.sessionPrefix}-1\`)
4. The agent is launched with context about the issue
5. Metadata is written to the project-specific sessions directory

### Monitoring Progress

Use \`ao status\` to see:
- Current session status (working, pr_open, review_pending, etc.)
- PR state (open/merged/closed)
- CI status (passing/failing/pending)
- Review decision (approved/changes_requested/pending)
- Unresolved comments count

### Sending Messages

Send instructions to a running agent:
\`\`\`bash
ao send ${project.sessionPrefix}-1 "Please address the review comments on your PR"
\`\`\`

### PR Takeover

If a worker session needs to continue work on an existing PR:
\`\`\`bash
ao session claim-pr 123 ${project.sessionPrefix}-1
# or do it at spawn time
ao spawn --claim-pr 123
\`\`\`

This updates AO metadata, switches the worker worktree onto the PR branch, and lets lifecycle reactions keep routing CI and review feedback to that worker session.

Never claim a PR into \`${project.sessionPrefix}-orchestrator\`. If a PR needs implementation or takeover, delegate it to a worker session instead.

### Investigation Workflow

When debugging or triaging from the orchestrator session:
1. Inspect with read-only commands such as \`ao status\`, \`ao session ls\`, \`ao session attach\`, and SCM/tracker lookups.
2. Decide whether a worker already owns the work or a new worker is needed.
3. Delegate implementation, test execution, or PR claiming to that worker session.
4. Return to monitoring and coordination once the worker has the task.

### Cleanup

Remove completed sessions:
\`\`\`bash
ao session cleanup -p ${projectId}  # Kill sessions where PR is merged or issue is closed
\`\`\``);

  // Dashboard
  sections.push(`## Dashboard

The web dashboard runs at **http://localhost:${config.port ?? 3000}**.

Features:
- Live session cards with activity status
- PR table with CI checks and review state
- Attention zones (merge ready, needs response, working, done)
- One-click actions (send message, kill, merge PR)
- Real-time updates via Server-Sent Events`);

  // Reactions (if configured)
  if (project.reactions && Object.keys(project.reactions).length > 0) {
    const reactionLines: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionLines.push(
          `- **${event}**: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
        );
      } else if (reaction.auto && reaction.action === "notify") {
        reactionLines.push(
          `- **${event}**: Notifies human (priority: ${reaction.priority ?? "info"})`,
        );
      }
    }

    if (reactionLines.length > 0) {
      sections.push(`## Automated Reactions

The system automatically handles these events:

${reactionLines.join("\n")}`);
    }
  }

  // Workflows
  sections.push(`## Common Workflows

### Bulk Issue Processing
1. Get list of issues from tracker (GitHub/Linear/etc.)
2. Use \`ao batch-spawn\` to spawn sessions for each issue
3. Monitor with \`ao status\` or the dashboard
4. Agents will fetch, implement, test, PR, and respond to reviews
5. Use \`ao session cleanup\` when PRs are merged

### Handling Stuck Agents
1. Check \`ao status\` for sessions in "stuck" or "needs_input" state
2. Attach with \`ao session attach <session>\` to see what they're doing
3. Send clarification or instructions with \`ao send <session> '...'\`
4. Or kill and respawn with fresh context if needed

### PR Review Flow
1. Agent creates PR and pushes
2. CI runs automatically
3. If CI fails: reaction auto-sends fix instructions to agent
4. If reviewers request changes: reaction auto-sends comments to agent
5. When approved + green: notify human to merge (unless auto-merge enabled)

### Manual Intervention
When an agent needs human judgment:
1. You'll get a notification (desktop/slack/webhook)
2. Check the dashboard or \`ao status\` for details
3. Attach to the session if needed: \`ao session attach <session>\`
4. Send instructions: \`ao send <session> '...'\`
5. Or handle the human-only action yourself (merge PR, close issue, etc.) while keeping implementation in worker sessions.`);

  // Tips
  sections.push(`## Tips

1. **Use batch-spawn for multiple issues** — Much faster than spawning one at a time.

2. **Check status before spawning** — Avoid creating duplicate sessions for issues already being worked on.

3. **Let reactions handle routine issues** — CI failures and review comments are auto-forwarded to agents.

4. **Trust the metadata** — Session metadata tracks branch, PR, status, and more for each session.

5. **Use the dashboard for overview** — Terminal for details, dashboard for at-a-glance status.

6. **Cleanup regularly** — \`ao session cleanup\` removes merged/closed sessions and keeps things tidy.

7. **Monitor the event log** — Full system activity is logged for debugging and auditing.

8. **Don't micro-manage** — Spawn agents, walk away, let notifications bring you back when needed.`);

  // Project-specific rules (if any)
  if (project.orchestratorRules) {
    sections.push(`## Project-Specific Rules

${project.orchestratorRules}`);
  }

  return sections.join("\n\n");
}

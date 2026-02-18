/**
 * Orchestrator Prompt Generator — generates CLAUDE.orchestrator.md content.
 *
 * This file is imported into CLAUDE.local.md (gitignored) in the main checkout
 * to provide orchestrator-specific context when the orchestrator agent runs.
 */

import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}

/**
 * Generate markdown content for CLAUDE.orchestrator.md.
 * Provides orchestrator agent with context about available commands,
 * session management workflows, and project configuration.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const { config, projectId, project } = opts;
  const sections: string[] = [];

  // Header
  sections.push(`# CLAUDE.orchestrator.md - ${project.name} Orchestrator

You are the **orchestrator agent** for the ${project.name} project.

Your role is to coordinate and manage worker agent sessions. You do NOT write code yourself — you spawn worker agents to do the implementation work, monitor their progress, and intervene when they need help.`);

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
ao spawn ${projectId} INT-1234
ao batch-spawn ${projectId} INT-1 INT-2 INT-3

# List sessions
ao session ls -p ${projectId}

# Send message to a session
ao send ${project.sessionPrefix}-1 "Your message here"

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
| \`ao spawn <project> [issue]\` | Spawn a single worker agent session |
| \`ao batch-spawn <project> <issues...>\` | Spawn multiple sessions in parallel |
| \`ao session ls [-p project]\` | List all sessions (optionally filter by project) |
| \`ao session attach <session>\` | Attach to a running session |
| \`ao session kill <session>\` | Kill a specific session |
| \`ao session cleanup [-p project]\` | Kill completed/merged sessions |
| \`ao send <session> <message>\` | Send a message to a running session |
| \`ao dashboard\` | Start the web dashboard (http://localhost:${config.port ?? 3000}) |
| \`ao dashboard restart [--clean] [--wait]\` | Restart the dashboard (optionally clean .next cache) |
| \`ao dashboard status\` | Show dashboard process status, port, and .next cache info |
| \`ao dashboard logs [--tail N] [--since T]\` | View dashboard log output |
| \`ao logs dashboard [--since T] [--level L]\` | Query structured dashboard logs |
| \`ao logs events [--session S] [--type T]\` | Query lifecycle event logs |
| \`ao perf routes\` | Per-route API response times (p50/p95/p99) |
| \`ao perf slow [--limit N]\` | Slowest recent API requests with timing breakdown |
| \`ao perf cache\` | Cache hit rates and effectiveness |
| \`ao retro list [--project P]\` | List session retrospectives |
| \`ao retro show <session>\` | View a specific session retrospective |
| \`ao retro generate <session>\` | Generate retrospective for a session |
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
- Real-time updates via Server-Sent Events
- **/logs** page — filterable log viewer (source, level, time range, session)
- **/perf** page — API performance dashboard (route stats, slow requests, cache hit rates)

### Dashboard Management

\`\`\`bash
# Check dashboard status
ao dashboard status

# Restart dashboard (e.g. after config changes)
ao dashboard restart

# Restart with .next cache clean (fixes compilation issues)
ao dashboard restart --clean --wait

# View recent dashboard output
ao dashboard logs --tail 50
\`\`\`

You can also restart the dashboard programmatically from code:
\`\`\`typescript
import { restartDashboard, waitForHealthy } from "@composio/ao-core";

const result = await restartDashboard({
  clean: true,
  webDir: "/path/to/packages/web",
  logDir: "/path/to/logs",
  port: ${config.port ?? 3000},
});
if (result.pid) await waitForHealthy(${config.port ?? 3000});
\`\`\``);

  // Logging & Debugging
  sections.push(`## Logging & Debugging

All system activity is logged to structured JSONL files for querying and analysis.

### Querying Logs

\`\`\`bash
# Dashboard output logs
ao logs dashboard --tail 20
ao logs dashboard --since 30m --level error

# Lifecycle event logs (state transitions, CI events, review events)
ao logs events --session ${project.sessionPrefix}-1
ao logs events --since 1h

# Session-specific logs
ao logs session ${project.sessionPrefix}-1
\`\`\`

### Performance Monitoring

\`\`\`bash
# Per-route response times
ao perf routes

# Find slowest API calls (enrichment bottlenecks, GitHub API latency)
ao perf slow --limit 10

# Cache effectiveness
ao perf cache
\`\`\`

### Session Retrospectives

After a session completes (merged or killed), a retrospective is auto-generated with timeline, metrics, and lessons learned.

\`\`\`bash
# List retrospectives
ao retro list --project ${projectId}

# View a specific retrospective
ao retro show ${project.sessionPrefix}-1

# Manually generate a retrospective
ao retro generate ${project.sessionPrefix}-1
\`\`\`

Use retrospectives to identify patterns: which sessions take longest, where CI repeatedly fails, which review patterns cause delays.`);

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
5. Or handle it yourself (merge PR, close issue, etc.)

### Debugging a Failing Session
1. Check logs: \`ao logs events --session <session-id>\` to see state transitions
2. Look for CI failures: \`ao logs events --session <session-id>\` | grep ci
3. Check the dashboard: \`ao logs dashboard --since 10m --level error\`
4. Attach if needed: \`ao session attach <session>\`

### Dashboard Not Loading
1. Check status: \`ao dashboard status\`
2. View errors: \`ao dashboard logs --tail 30\`
3. Restart with clean cache: \`ao dashboard restart --clean --wait\`
4. If still broken, check perf: \`ao perf routes\` for slow endpoints

### Reviewing Past Performance
1. \`ao retro list\` — see outcomes of completed sessions
2. \`ao perf routes\` — identify slow API endpoints
3. \`ao perf slow\` — find specific bottlenecks
4. Use insights to tune reactions, improve agent prompts, or optimize code`);

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

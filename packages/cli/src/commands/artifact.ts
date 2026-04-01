/**
 * CLI commands for the artifact system.
 *
 * ao artifact publish|publish-ref|list|show|read|update|summary|grep|stats|delete
 */

import { resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  getArtifactsDir,
  getSessionsDir,
  type ArtifactFilter,
  type ArtifactCategory,
  type ArtifactStatus,
  type ArtifactService,
} from "@composio/ao-core";
import { createArtifactService } from "@composio/ao-plugin-artifact-file/artifact-service";

function resolveArtifactsDir(opts: { project?: string }): {
  artifactsDir: string;
  sessionsDir: string;
  projectId: string;
} {
  // If AO_ARTIFACTS_DIR is set (agent context), use it directly
  const envDir = process.env.AO_ARTIFACTS_DIR;
  if (envDir) {
    return {
      artifactsDir: envDir,
      sessionsDir: process.env.AO_DATA_DIR ?? "",
      projectId: process.env.AO_PROJECT_ID ?? "",
    };
  }

  // Otherwise resolve from config
  const config = loadConfig();
  const projectId = opts.project ?? Object.keys(config.projects)[0];
  if (!projectId || !config.projects[projectId]) {
    console.error(chalk.red(`Unknown project: ${opts.project ?? "(none)"}`));
    process.exit(1);
  }
  const project = config.projects[projectId];
  return {
    artifactsDir: getArtifactsDir(config.configPath, project.path),
    sessionsDir: getSessionsDir(config.configPath, project.path),
    projectId,
  };
}

function getService(opts: { project?: string }): ArtifactService {
  const { artifactsDir, sessionsDir } = resolveArtifactsDir(opts);
  return createArtifactService({ artifactsDir, sessionsDir });
}

function defaultSession(): string {
  return process.env.AO_SESSION ?? "";
}

function defaultIssue(): string {
  return process.env.AO_ISSUE_ID ?? "";
}

function buildFilter(opts: {
  session?: string;
  issue?: string;
  category?: string;
  status?: string;
  last?: string;
  includeDeleted?: boolean;
}): ArtifactFilter {
  const filter: ArtifactFilter = {};
  if (opts.session) filter.sessionId = opts.session;
  if (opts.issue) filter.issueId = opts.issue;
  if (opts.category) filter.category = opts.category as ArtifactCategory;
  if (opts.status) filter.status = opts.status as ArtifactStatus;
  if (opts.last) filter.lastN = parseInt(opts.last, 10);
  if (opts.includeDeleted) filter.includeDeleted = true;
  return filter;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function registerArtifact(program: Command): void {
  const artifact = program
    .command("artifact")
    .description("Manage session artifacts (publish, list, grep, read)");

  // ─── publish ─────────────────────────────────────────────────────────
  artifact
    .command("publish <file>")
    .description("Publish a file as a session artifact")
    .option("--category <cat>", "Category: pr, document, test-report, screenshot, log, other", "other")
    .option("--description <text>", "Human-readable description")
    .option("--session <id>", "Session ID (default: $AO_SESSION)")
    .option("--issue <id>", "Issue ID (default: $AO_ISSUE_ID)")
    .option("--status <status>", "Initial status: draft or published", "published")
    .option("--tags <tags>", "Comma-separated tags")
    .option("-p, --project <id>", "Project ID")
    .action(
      async (
        file: string,
        opts: {
          category: string;
          description?: string;
          session?: string;
          issue?: string;
          status?: string;
          tags?: string;
          project?: string;
        },
      ) => {
        const sessionId = opts.session || defaultSession();
        if (!sessionId) {
          console.error(chalk.red("No session ID. Use --session or set AO_SESSION."));
          process.exit(1);
        }

        const service = getService(opts);
        await service.init();

        const filePath = resolve(file);
        const entry = await service.publish(sessionId, filePath, {
          category: opts.category as ArtifactCategory,
          description: opts.description,
          status: (opts.status as ArtifactStatus) ?? "published",
          tags: opts.tags?.split(",").map((t) => t.trim()),
          issueId: opts.issue || defaultIssue() || undefined,
        });

        console.log(
          `${chalk.green("OK:")} artifact:${entry.id.slice(0, 8)} (${entry.category}) → ${entry.path}`,
        );
      },
    );

  // ─── publish-ref ─────────────────────────────────────────────────────
  artifact
    .command("publish-ref")
    .description("Register an external artifact by reference")
    .requiredOption("--type <type>", "Reference type: pr, issue, deployment, external")
    .requiredOption("--url <url>", "Reference URL")
    .option("--description <text>", "Human-readable description", "")
    .option("--session <id>", "Session ID (default: $AO_SESSION)")
    .option("--issue <id>", "Issue ID (default: $AO_ISSUE_ID)")
    .option("-p, --project <id>", "Project ID")
    .action(
      async (opts: {
        type: string;
        url: string;
        description: string;
        session?: string;
        issue?: string;
        project?: string;
      }) => {
        const sessionId = opts.session || defaultSession();
        if (!sessionId) {
          console.error(chalk.red("No session ID. Use --session or set AO_SESSION."));
          process.exit(1);
        }

        const service = getService(opts);
        await service.init();

        const category = opts.type === "pr" ? "pr" : "other";
        const entry = await service.publishReference(sessionId, {
          referenceType: opts.type,
          referenceUrl: opts.url,
          category: category as ArtifactCategory,
          description: opts.description,
          issueId: opts.issue || defaultIssue() || undefined,
        });

        console.log(
          `${chalk.green("OK:")} artifact:${entry.id.slice(0, 8)} (${entry.referenceType} ref) → ${entry.referenceUrl}`,
        );
      },
    );

  // ─── list ────────────────────────────────────────────────────────────
  artifact
    .command("list")
    .description("List artifacts")
    .option("--session <id>", "Filter by session")
    .option("--issue <id>", "Filter by issue (across all sessions)")
    .option("--category <cat>", "Filter by category")
    .option("--status <status>", "Filter by status")
    .option("--last <n>", "Only from last N sessions")
    .option("--include-deleted", "Include tombstoned artifacts")
    .option("--format <fmt>", "Output format: table, json, paths", "table")
    .option("-p, --project <id>", "Project ID")
    .action(
      async (opts: {
        session?: string;
        issue?: string;
        category?: string;
        status?: string;
        last?: string;
        includeDeleted?: boolean;
        format: string;
        project?: string;
      }) => {
        const service = getService(opts);
        if (!(await service.isInitialized())) {
          console.log(chalk.dim("No artifacts yet."));
          return;
        }

        const entries = await service.list(buildFilter(opts));

        if (opts.format === "json") {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (opts.format === "paths") {
          for (const e of entries) {
            console.log(e.isReference ? e.referenceUrl : e.path);
          }
          return;
        }

        if (entries.length === 0) {
          console.log(chalk.dim("No matching artifacts."));
          return;
        }

        // Table format
        console.log(
          chalk.bold(
            `${"ID".padEnd(10)} ${"Session".padEnd(14)} ${"Category".padEnd(13)} ${"Status".padEnd(11)} ${"Size".padEnd(8)} ${"Age".padEnd(10)} Description`,
          ),
        );
        for (const e of entries) {
          const id = e.id.slice(0, 8);
          const desc = e.isReference
            ? chalk.cyan(e.referenceUrl ?? e.filename)
            : (e.description ?? e.filename);
          console.log(
            `${id.padEnd(10)} ${e.sessionId.padEnd(14)} ${e.category.padEnd(13)} ${e.status.padEnd(11)} ${formatSize(e.size).padEnd(8)} ${formatAge(e.createdAt).padEnd(10)} ${desc}`,
          );
        }
        console.log(chalk.dim(`\n${entries.length} artifact${entries.length !== 1 ? "s" : ""}`));
      },
    );

  // ─── show ────────────────────────────────────────────────────────────
  artifact
    .command("show <id>")
    .description("Show artifact metadata and content preview")
    .option("-p, --project <id>", "Project ID")
    .action(async (id: string, opts: { project?: string }) => {
      const service = getService(opts);
      const result = await service.get(id);
      if (!result) {
        console.error(chalk.red(`Artifact not found: ${id}`));
        process.exit(1);
      }
      const { entry } = result;
      console.log(chalk.bold("Artifact Details"));
      console.log(`  ID:          ${entry.id}`);
      console.log(`  Session:     ${entry.sessionId}`);
      if (entry.issueId) console.log(`  Issue:       ${entry.issueId}`);
      console.log(`  Category:    ${entry.category}`);
      console.log(`  Status:      ${entry.status}`);
      console.log(`  MIME:        ${entry.mimeType}`);
      console.log(`  Size:        ${formatSize(entry.size)}`);
      console.log(`  Created:     ${entry.createdAt}`);
      if (entry.description) console.log(`  Description: ${entry.description}`);
      if (entry.tags?.length) console.log(`  Tags:        ${entry.tags.join(", ")}`);
      if (entry.isReference) {
        console.log(`  Type:        ${entry.referenceType} reference`);
        console.log(`  URL:         ${entry.referenceUrl}`);
      }
      if (entry.deletedAt) {
        console.log(`  Deleted:     ${entry.deletedAt}`);
        if (entry.deletedBy) console.log(`  Deleted by:  ${entry.deletedBy}`);
      }

      // Content preview for text artifacts
      const content = await service.readContent(id);
      if (content) {
        console.log(chalk.bold("\nContent Preview (first 20 lines):"));
        const lines = content.split("\n").slice(0, 20);
        for (const line of lines) {
          console.log(`  ${line}`);
        }
        const totalLines = content.split("\n").length;
        if (totalLines > 20) {
          console.log(chalk.dim(`  ... (${totalLines - 20} more lines)`));
        }
      }
    });

  // ─── read ────────────────────────────────────────────────────────────
  artifact
    .command("read <id>")
    .description("Print raw text content to stdout")
    .option("-p, --project <id>", "Project ID")
    .action(async (id: string, opts: { project?: string }) => {
      const service = getService(opts);
      const content = await service.readContent(id);
      if (content === null) {
        console.error(chalk.red(`Cannot read artifact: ${id} (not found or binary)`));
        process.exit(1);
      }
      process.stdout.write(content);
    });

  // ─── update ──────────────────────────────────────────────────────────
  artifact
    .command("update <id>")
    .description("Update artifact metadata")
    .option("--status <status>", "New status: draft, published, verified, archived")
    .option("--description <text>", "New description")
    .option("--tags <tags>", "New comma-separated tags")
    .option("-p, --project <id>", "Project ID")
    .action(
      async (
        id: string,
        opts: {
          status?: string;
          description?: string;
          tags?: string;
          project?: string;
        },
      ) => {
        const service = getService(opts);
        const updates: { status?: ArtifactStatus; description?: string; tags?: string[] } = {};
        if (opts.status) updates.status = opts.status as ArtifactStatus;
        if (opts.description) updates.description = opts.description;
        if (opts.tags) updates.tags = opts.tags.split(",").map((t) => t.trim());

        const entry = await service.update(id, updates);
        console.log(
          `${chalk.green("OK:")} artifact:${entry.id.slice(0, 8)} updated (status: ${entry.status})`,
        );
      },
    );

  // ─── summary ─────────────────────────────────────────────────────────
  artifact
    .command("summary")
    .description("One-line summary of artifact state")
    .option("--session <id>", "Scope to session")
    .option("-p, --project <id>", "Project ID")
    .action(async (opts: { session?: string; project?: string }) => {
      const service = getService(opts);
      if (!(await service.isInitialized())) {
        console.log(chalk.dim("No artifacts yet."));
        return;
      }

      const filter: ArtifactFilter = {};
      if (opts.session) filter.sessionId = opts.session;
      const entries = await service.list(filter);

      if (entries.length === 0) {
        const scope = opts.session ? `${opts.session}: ` : "";
        console.log(`${scope}No artifacts.`);
        return;
      }

      const categoryCounts = new Map<string, number>();
      let lastCreatedAt = "";
      for (const e of entries) {
        categoryCounts.set(e.category, (categoryCounts.get(e.category) ?? 0) + 1);
        if (!lastCreatedAt || e.createdAt > lastCreatedAt) lastCreatedAt = e.createdAt;
      }

      const cats = [...categoryCounts.entries()]
        .map(([cat, count]) => `${count} ${cat}${count !== 1 ? "s" : ""}`)
        .join(", ");
      const sessions = new Set(entries.map((e) => e.sessionId));
      const scope = opts.session ?? `${sessions.size} session${sessions.size !== 1 ? "s" : ""}`;
      console.log(
        `${scope}: ${entries.length} artifacts (${cats}). Last: ${formatAge(lastCreatedAt)}`,
      );
    });

  // ─── grep ────────────────────────────────────────────────────────────
  artifact
    .command("grep <pattern>")
    .description("Full-text search across text-based artifacts")
    .option("--session <id>", "Scope to session")
    .option("--issue <id>", "Scope to issue")
    .option("--category <cat>", "Scope to category")
    .option("--last <n>", "Scope to last N sessions")
    .option("--context <n>", "Show N surrounding lines", "2")
    .option("-p, --project <id>", "Project ID")
    .action(
      async (
        pattern: string,
        opts: {
          session?: string;
          issue?: string;
          category?: string;
          last?: string;
          context?: string;
          project?: string;
        },
      ) => {
        const service = getService(opts);
        if (!(await service.isInitialized())) {
          console.log(chalk.dim("No artifacts to search."));
          return;
        }

        const results = await service.grep(pattern, buildFilter(opts));

        if (results.length === 0) {
          console.log(chalk.dim(`No matches for "${pattern}".`));
          return;
        }

        for (const result of results) {
          const { artifact: art, matches } = result;
          console.log(
            chalk.bold(`\n${art.path}`) +
              chalk.dim(` (${art.sessionId}, ${art.category})`),
          );
          for (const match of matches) {
            console.log(chalk.yellow(`  L${match.line}: `) + match.content);
          }
        }

        const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
        console.log(
          chalk.dim(
            `\n${totalMatches} match${totalMatches !== 1 ? "es" : ""} in ${results.length} artifact${results.length !== 1 ? "s" : ""}`,
          ),
        );
      },
    );

  // ─── stats ───────────────────────────────────────────────────────────
  artifact
    .command("stats")
    .description("Show artifact counts and sizes")
    .option("--include-deleted", "Include tombstoned artifacts")
    .option("-p, --project <id>", "Project ID")
    .action(async (opts: { includeDeleted?: boolean; project?: string }) => {
      const service = getService(opts);
      if (!(await service.isInitialized())) {
        console.log(chalk.dim("No artifacts yet."));
        return;
      }

      const all = await service.list({ includeDeleted: true });
      const active = all.filter((e) => e.status !== "deleted");
      const deleted = all.filter((e) => e.status === "deleted");

      const activeSize = active.reduce((sum, e) => sum + e.size, 0);
      const sessions = new Set(active.map((e) => e.sessionId));

      console.log(chalk.bold("Artifact Stats"));
      console.log(`  Active:     ${active.length} artifacts (${formatSize(activeSize)})`);
      console.log(`  Deleted:    ${deleted.length} artifacts`);
      console.log(`  Sessions:   ${sessions.size}`);

      if (active.length > 0) {
        const categoryCounts = new Map<string, number>();
        for (const e of active) {
          categoryCounts.set(e.category, (categoryCounts.get(e.category) ?? 0) + 1);
        }
        console.log(chalk.bold("\n  By Category:"));
        for (const [cat, count] of categoryCounts) {
          console.log(`    ${cat}: ${count}`);
        }
      }
    });

  // ─── delete ──────────────────────────────────────────────────────────
  artifact
    .command("delete <id>")
    .description("Delete an artifact (tombstone by default, --purge for hard delete)")
    .option("--purge", "Hard delete: remove file AND manifest entry")
    .option("-p, --project <id>", "Project ID")
    .action(async (id: string, opts: { purge?: boolean; project?: string }) => {
      const service = getService(opts);
      const deletedBy = defaultSession() || undefined;
      await service.delete(id, { purge: opts.purge, deletedBy });
      const mode = opts.purge ? "purged" : "tombstoned";
      console.log(`${chalk.green("OK:")} artifact:${id.slice(0, 8)} ${mode}`);
    });
}

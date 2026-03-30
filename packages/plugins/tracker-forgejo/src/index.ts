/**
 * tracker-forgejo plugin — Forgejo Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all Forgejo API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[], hostname?: string): Promise<string> {
  const env = hostname ? { ...process.env, GH_HOST: hostname } : process.env;
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      env,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function repoHost(repo: string): string | undefined {
  const parts = repo.split("/");
  const first = parts[0];
  return first && first.includes(".") && parts.length >= 3 ? first : undefined;
}

function stripHost(repo: string): string {
  const parts = repo.split("/");
  if (parts[0] && parts[0].includes(".") && parts.length >= 3) {
    return parts.slice(1).join("/");
  }
  return repo;
}

function defaultForgejoHost(): string | undefined {
  const envHost = process.env["GH_HOST"]?.trim();
  if (!envHost) return undefined;
  return envHost;
}

function getErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "";

  const details: string[] = [err.message];
  const withIo = err as Error & { stderr?: string; stdout?: string; cause?: unknown };
  if (typeof withIo.stderr === "string") details.push(withIo.stderr);
  if (typeof withIo.stdout === "string") details.push(withIo.stdout);
  if (withIo.cause instanceof Error) details.push(getErrorText(withIo.cause));

  return details.join("\n").toLowerCase();
}

function isUnknownJsonFieldError(err: unknown, fieldName: string): boolean {
  const text = getErrorText(err);
  if (!text) return false;

  const unknownFieldSignals =
    text.includes("unknown json field") ||
    text.includes("unknown field") ||
    text.includes("invalid field");

  return unknownFieldSignals && text.includes(fieldName.toLowerCase());
}

async function ghIssueViewJson(
  identifier: string,
  project: ProjectConfig,
  hostname?: string,
): Promise<string> {
  const fieldsWithStateReason = "number,title,body,url,state,stateReason,labels,assignees";
  try {
    return await gh([
      "issue",
      "view",
      identifier,
      "--repo",
      project.repo,
      "--json",
      fieldsWithStateReason,
    ], hostname);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([
      "issue",
      "view",
      identifier,
      "--repo",
      project.repo,
      "--json",
      "number,title,body,url,state,labels,assignees",
    ], hostname);
  }
}

async function ghIssueListJson(args: string[], hostname?: string): Promise<string> {
  const withStateReason = [
    ...args,
    "--json",
    "number,title,body,url,state,stateReason,labels,assignees",
  ];
  try {
    return await gh(withStateReason, hostname);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([...args, "--json", "number,title,body,url,state,labels,assignees"], hostname);
  }
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createForgejoTracker(config?: Record<string, unknown>): Tracker {
  const hostname = typeof config?.host === "string" ? config.host : undefined;

  return {
    name: "forgejo",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const raw = await ghIssueViewJson(identifier, project, hostname);

      const data: {
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      } = JSON.parse(raw);

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        project.repo,
        "--json",
        "state",
      ], hostname);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      const host = hostname ?? repoHost(project.repo) ?? defaultForgejoHost() ?? "forgejo.example";
      return `https://${host}/${stripHost(project.repo)}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from Forgejo URL
      // Example: https://forgejo.example/owner/repo/issues/42 → "#42"
      const match = url.match(/\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Forgejo issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = [
        "issue",
        "list",
        "--repo",
        project.repo,
        "--limit",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--state", "closed");
      } else if (filters.state === "all") {
        args.push("--state", "all");
      } else {
        args.push("--state", "open");
      }

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await ghIssueListJson(args, hostname);
      const issues: Array<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      }> = JSON.parse(raw);

      return issues.map((data) => ({
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      // Handle state change — Forgejo Issues only supports open/closed.
      // "in_progress" is not a Forgejo state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", project.repo], hostname);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", project.repo], hostname);
      }

      // Handle label removal
      if (update.removeLabels && update.removeLabels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--remove-label",
          update.removeLabels.join(","),
        ], hostname);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-label",
          update.labels.join(","),
        ], hostname);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          project.repo,
          "--add-assignee",
          update.assignee,
        ], hostname);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          project.repo,
          "--body",
          update.comment,
        ], hostname);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        project.repo,
        "--title",
        input.title,
        "--body",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      // gh issue create outputs the URL of the new issue
      const url = await gh(args, hostname);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return this.getIssue(number, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "forgejo",
  slot: "tracker" as const,
  description: "Tracker plugin: Forgejo Issues",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  return createForgejoTracker(config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;

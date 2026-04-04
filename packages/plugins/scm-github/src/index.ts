/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type SCMWebhookEvent,
  type SCMWebhookRequest,
  type SCMWebhookVerificationResult,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type AutomatedComment,
  type MergeReadiness,
  type PREnrichmentData,
  type BatchObserver,
} from "@composio/ao-core";
import {
  enrichSessionsPRBatch as enrichSessionsPRBatchImpl,
} from "./graphql-batch.js";
import {
  getWebhookHeader,
  parseWebhookBranchRef,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
} from "@composio/ao-core/scm-webhook-utils";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Rate Limit Handling
// ---------------------------------------------------------------------------

const RATE_LIMIT_ERROR_PATTERNS = [
  "rate limit",
  "rate Limit",
  "API rate limit",
  "GraphQL rate limit",
  "rate limit exceeded",
  "Too Many Requests",
];

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (RATE_LIMIT_ERROR_PATTERNS.some((pattern) => msg.toLowerCase().includes(pattern.toLowerCase()))) {
    return true;
  }
  if (error instanceof Error && error.cause) {
    return isRateLimitError(error.cause);
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parsed `gh pr view ... --json a,b,c` for REST fallback synthesis. */
type PrViewRestConversion = {
  repo: string;
  prNumber: string;
  jsonFields: string[];
};

function parsePrViewRestConversion(args: string[]): PrViewRestConversion | null {
  if (args[0] !== "pr" || args[1] !== "view") return null;

  const prNumber = args[2];
  if (!prNumber || !/^\d+$/.test(prNumber)) return null;

  const repoIdx = args.indexOf("--repo");
  if (repoIdx === -1 || !args[repoIdx + 1]) return null;

  const repo = args[repoIdx + 1];
  const jIdx = args.indexOf("--json");
  const jsonFields =
    jIdx !== -1 && args[jIdx + 1]
      ? args[jIdx + 1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return { repo, prNumber, jsonFields };
}

/** Map GitHub REST `mergeable_state` to GraphQL-style `mergeStateStatus` tokens. */
function restMergeableStateToGraphqlMergeStateStatus(raw: string): string {
  const up = raw.toUpperCase();
  const map: Record<string, string> = {
    CLEAN: "CLEAN",
    DIRTY: "DIRTY",
    BLOCKED: "BLOCKED",
    UNSTABLE: "UNSTABLE",
    UNKNOWN: "UNKNOWN",
    BEHIND: "BEHIND",
    DRAFT: "DRAFT",
  };
  return map[up] ?? (up || "UNKNOWN");
}

type RestReviewRow = {
  state?: string;
  user?: { login?: string };
  body?: string;
  submitted_at?: string;
};

/**
 * Approximate `gh pr view --json reviewDecision` from REST /pulls/{n}/reviews.
 * Empty list is treated as REVIEW_REQUIRED (conservative vs GraphQL "no decision").
 *
 * COMMENTED reviews are non-decisive — they don't override an existing APPROVED
 * or CHANGES_REQUESTED decision. Only the latest decisive review per reviewer counts.
 */
function deriveReviewDecisionGraphqlFromReviews(reviewsUnknown: unknown): string {
  if (!Array.isArray(reviewsUnknown)) return "REVIEW_REQUIRED";
  const rows = reviewsUnknown as RestReviewRow[];
  if (rows.length === 0) return "REVIEW_REQUIRED";

  const decisiveStates = new Set(["APPROVED", "CHANGES_REQUESTED"]);
  const byUser = new Map<string, RestReviewRow>();
  for (const r of rows) {
    const login = r.user?.login ?? "";
    if (!decisiveStates.has((r.state ?? "").toUpperCase())) continue;
    const prev = byUser.get(login);
    const t = r.submitted_at ? Date.parse(r.submitted_at) : 0;
    const pt = prev?.submitted_at ? Date.parse(prev.submitted_at) : 0;
    if (!prev || t >= pt) byUser.set(login, r);
  }
  const latest = [...byUser.values()];

  if (latest.some((r) => (r.state ?? "").toUpperCase() === "CHANGES_REQUESTED")) {
    return "CHANGES_REQUESTED";
  }
  if (latest.length > 0 && latest.every((r) => (r.state ?? "").toUpperCase() === "APPROVED")) {
    return "APPROVED";
  }
  return "REVIEW_REQUIRED";
}

function mapRestReviewsToPrViewReviewsShape(reviewsUnknown: unknown): Array<{
  author: { login: string };
  state: string;
  body: string;
  submittedAt: string;
}> {
  if (!Array.isArray(reviewsUnknown)) return [];
  return (reviewsUnknown as RestReviewRow[]).map((r) => ({
    author: { login: r.user?.login ?? "unknown" },
    state: r.state ?? "",
    body: r.body ?? "",
    submittedAt: r.submitted_at ?? "",
  }));
}

function synthesizePrViewJsonFromRest(
  rest: Record<string, unknown>,
  jsonFields: string[],
  opts: { reviewDecision?: string; reviewsPayload?: unknown; statusCheckRollup?: unknown[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const want = new Set(jsonFields);

  if (want.has("state")) {
    // REST API returns state:"closed" with merged:true for merged PRs.
    // GraphQL gh pr view returns state:"MERGED". Normalise so callers
    // (getPRState, getMergeability) see the same shape regardless of path.
    if (rest.state === "closed" && rest.merged === true) {
      out.state = "MERGED";
    } else if (typeof rest.state === "string") {
      out.state = rest.state.toUpperCase();
    } else {
      out.state = rest.state;
    }
    if (rest.merged !== undefined) out.merged = rest.merged;
  }
  if (want.has("title") && rest.title !== undefined) out.title = rest.title;
  if (want.has("additions") && rest.additions !== undefined) out.additions = rest.additions;
  if (want.has("deletions") && rest.deletions !== undefined) out.deletions = rest.deletions;

  if (want.has("mergeable")) {
    const m = rest.mergeable;
    if (m === true) out.mergeable = "MERGEABLE";
    else if (m === false) out.mergeable = "CONFLICTING";
    else if (m === null) out.mergeable = "UNKNOWN";
    else if (typeof m === "string") out.mergeable = m;
    else out.mergeable = "UNKNOWN";
  }

  if (want.has("isDraft")) {
    out.isDraft = Boolean(rest.draft);
  }

  if (want.has("mergeStateStatus")) {
    const rawMs = typeof rest.mergeable_state === "string" ? rest.mergeable_state : "";
    out.mergeStateStatus = restMergeableStateToGraphqlMergeStateStatus(rawMs);
  }

  if (want.has("reviewDecision")) {
    out.reviewDecision = opts.reviewDecision ?? "REVIEW_REQUIRED";
  }

  if (want.has("reviews") && opts.reviewsPayload !== undefined) {
    out.reviews = mapRestReviewsToPrViewReviewsShape(opts.reviewsPayload);
  }

  if (want.has("statusCheckRollup") && opts.statusCheckRollup !== undefined) {
    out.statusCheckRollup = opts.statusCheckRollup;
  }

  // REST API uses head.sha; GraphQL gh pr view uses headRefOid. Map accordingly.
  if (want.has("headRefOid")) {
    const headObj = rest.head as Record<string, unknown> | undefined;
    if (typeof headObj?.sha === "string") out.headRefOid = headObj.sha;
  }

  for (const f of jsonFields) {
    if (f in out || !(f in rest)) continue;
    out[f] = rest[f];
  }

  return out;
}

async function fetchPrViewFallbackAsJson(
  conv: PrViewRestConversion,
  cwd?: string,
): Promise<string> {
  const pullRaw = await execCli("gh", ["api", `repos/${conv.repo}/pulls/${conv.prNumber}`], cwd);
  const restObj = JSON.parse(pullRaw) as Record<string, unknown>;

  let reviewDecision: string | undefined;
  let reviewsPayload: unknown;
  const needReviews =
    conv.jsonFields.includes("reviewDecision") || conv.jsonFields.includes("reviews");

  if (needReviews) {
    try {
      let revRaw = "";
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          revRaw = await execCli(
            "gh",
            ["api", `repos/${conv.repo}/pulls/${conv.prNumber}/reviews`, "--paginate"],
            cwd,
          );
          break;
        } catch (err) {
          lastErr = err;
          if (!isRateLimitError(err)) throw err;
          if (attempt < 2) await sleep(Math.min(1000 * Math.pow(2, attempt), 30000));
        }
      }
      if (!revRaw && lastErr) throw lastErr;
      reviewsPayload = JSON.parse(revRaw);
      if (conv.jsonFields.includes("reviewDecision")) {
        reviewDecision = deriveReviewDecisionGraphqlFromReviews(reviewsPayload);
      }
    } catch (err) {
      if (conv.jsonFields.includes("reviews")) throw err;
      reviewDecision = "REVIEW_REQUIRED";
    }
  }

  // Fetch check-runs via REST when statusCheckRollup is requested.
  let statusCheckRollup: unknown[] | undefined;
  if (conv.jsonFields.includes("statusCheckRollup")) {
    const headObj = restObj.head as Record<string, unknown> | undefined;
    const sha = typeof headObj?.sha === "string" ? headObj.sha : undefined;
    if (!sha) {
      // Throw so the caller (ghWithRetry) re-throws lastError (the original
      // rate-limit error), keeping fail-closed behavior consistent with
      // getCIChecksFromStatusRollupViaRest which also throws when SHA is missing.
      throw new Error(
        `fetchPrViewFallbackAsJson: could not determine head SHA for ${conv.repo}#${conv.prNumber}`,
      );
    }
    statusCheckRollup = await fetchCheckRunsViaRest(conv.repo, sha, cwd);
  }

  return JSON.stringify(
    synthesizePrViewJsonFromRest(restObj, conv.jsonFields, {
      reviewDecision,
      reviewsPayload,
      statusCheckRollup,
    }),
  );
}

/**
 * Write a temporary curl config file containing the Authorization header.
 * The file is created with mode 0o600 (owner-only read/write) to keep the
 * token out of the process argument list (visible in `ps`).
 */
function writeTempCurlConfig(token: string): string {
  const configPath = join(tmpdir(), `.curl-auth-${randomUUID()}`);
  const escapedToken = token.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  writeFileSync(configPath, `header = "Authorization: Bearer ${escapedToken}"\n`, {
    mode: 0o600,
  });
  return configPath;
}

/** Best-effort cleanup of a temporary curl config file. */
function cleanupTempCurlConfig(configPath: string | undefined): void {
  if (!configPath) return;
  try {
    unlinkSync(configPath);
  } catch {
    // Best-effort: file may already be gone
  }
}

/**
 * Fallback to direct REST API calls using curl when gh CLI is rate limited.
 * Supports `gh api repos/...` invocations only. GraphQL calls are not supported.
 *
 * Supported forms:
 *   gh api repos/owner/repo/pulls
 *   gh api /repos/owner/repo/pulls
 *   gh api repos/owner/repo/pulls --method GET
 *
 * For unsupported forms (e.g. `gh api graphql`), this function throws so that
 * the caller can rethrow the original gh error.
 */
export async function ghRestFallback(args: string[]): Promise<string> {
  if (!Array.isArray(args) || args.length === 0 || args[0] !== "api") {
    throw new Error("ghRestFallback only supports `gh api` commands");
  }

  const apiArgs = args.slice(1);
  if (apiArgs.length === 0) {
    throw new Error("ghRestFallback: missing endpoint for `gh api` command");
  }

  // gh api flags that take a value argument — both loops must agree on this set
  // so that flag values (e.g. ".name" for --jq .name) are not mistaken for the endpoint.
  const GH_API_FLAGS_WITH_VALUE = new Set(["--method", "-X", "--jq", "-q", "-f", "--field", "--raw-field", "--input"]);
  // gh api flags that are boolean/standalone
  const GH_API_FLAGS_BOOLEAN = new Set(["--paginate", "--silent", "--include"]);

  // Find the first positional argument (endpoint) — skip all known value-taking
  // and boolean flags so their values are not mistaken for the endpoint.
  // Track the index so the flag collection loop below can skip it correctly.
  let endpoint = "";
  let endpointIdx = -1;
  for (let i = 0; i < apiArgs.length; i++) {
    const arg = apiArgs[i];
    if (GH_API_FLAGS_WITH_VALUE.has(arg)) {
      i++; // Skip the flag's value argument
    } else if (GH_API_FLAGS_BOOLEAN.has(arg)) {
      // standalone flag — no value to skip
    } else if (!arg.startsWith("-")) {
      endpoint = arg;
      endpointIdx = i;
      break;
    }
    // Unknown flags starting with "-" are skipped (no value consumed)
  }
  if (!endpoint) {
    throw new Error("ghRestFallback: missing endpoint for `gh api` command");
  }

  if (endpoint === "graphql" || endpoint.startsWith("graphql/")) {
    throw new Error("ghRestFallback does not support GraphQL queries");
  }

  if (endpoint.startsWith("/")) {
    endpoint = endpoint.slice(1);
  }

  // Retrieve auth token for the REST API call
  let token = "";
  try {
    const { stdout: tokenOutput } = await execFileAsync("gh", ["auth", "token"], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    token = tokenOutput.trim();
  } catch {
    // No auth available — continue without token (hits lower rate limits)
  }

  // Collect flags from ALL positions in apiArgs (except the endpoint itself).
  // Starting from 0 (not 1) ensures flags before the endpoint are included.
  //
  // Only --method/-X is forwarded to curl. All other gh api-specific flags
  // (--paginate, --jq, -f, --field, --input, --raw-field, etc.) are ignored
  // because curl doesn't understand them and they have no REST equivalent here.
  const queryParts: string[] = [];
  const curlFlags: string[] = [];

  for (let i = 0; i < apiArgs.length; i++) {
    if (i === endpointIdx) continue; // skip the endpoint
    const arg = apiArgs[i];
    if (arg.startsWith("?")) {
      queryParts.push(arg.slice(1));
    } else if (arg === "--method" || arg === "-X") {
      // Guard read-ahead: don't consume the endpoint as the method value
      const next = i + 1 !== endpointIdx ? apiArgs[i + 1] : undefined;
      curlFlags.push("-X", next || "GET");
      if (next) i++;
    } else if (GH_API_FLAGS_WITH_VALUE.has(arg)) {
      // Skip gh-specific flag + its value (guard against consuming endpoint)
      if (i + 1 < apiArgs.length && i + 1 !== endpointIdx) i++;
    } else if (GH_API_FLAGS_BOOLEAN.has(arg)) {
      // Skip gh-specific boolean flag
    } else if (arg.startsWith("-")) {
      // Unknown flag — skip it rather than forwarding blindly to curl
    }
  }

  let url = `https://api.github.com/${endpoint}`;
  if (queryParts.length > 0) {
    url += "?" + queryParts.join("&");
  }

  const curlArgs = [
    "-f",
    "-sS",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
  ];

  let curlConfigPath: string | undefined;
  if (token) {
    curlConfigPath = writeTempCurlConfig(token);
    curlArgs.push("--config", curlConfigPath);
  }

  curlArgs.push(...curlFlags, url);

  try {
    const { stdout } = await execFileAsync("curl", curlArgs, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`REST fallback failed: ${(err as Error).message}`, { cause: err });
  } finally {
    cleanupTempCurlConfig(curlConfigPath);
  }
}

/**
 * Execute gh CLI with rate limit retry and REST API fallback.
 * Uses exponential backoff on rate limit errors, then falls back to:
 * - `ghRestFallback()` for `gh api` calls
 * - `fetchPrViewFallbackAsJson()` for `gh pr view --json` calls
 */
async function ghWithRetry(
  args: string[],
  cwd?: string,
  maxRetries = 3,
  env?: Record<string, string>,
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await execCli("gh", args, cwd, env);
    } catch (err) {
      lastError = err;

      if (isRateLimitError(err)) {
        if (attempt < maxRetries - 1) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 30000);
          console.warn(
            `GitHub rate limit detected, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxRetries})`,
          );
          await sleep(backoffMs);
        }
      } else {
        // Non-rate-limit error — don't retry
        throw err;
      }
    }
  }

  // All retries exhausted — attempt REST fallback
  if (args[0] === "api") {
    console.warn("Gh CLI rate limit retries exhausted, trying REST API fallback for `gh api` call");
    try {
      return await ghRestFallback(args);
    } catch {
      if (lastError instanceof Error) throw lastError;
      throw new Error(String(lastError));
    }
  }

  if (args[0] === "pr" && args[1] === "view") {
    const conv = parsePrViewRestConversion(args);
    if (conv) {
      console.warn(
        "Gh CLI rate limit retries exhausted, trying REST API fallback for `gh pr view` call",
      );
      try {
        return await fetchPrViewFallbackAsJson(conv, cwd);
      } catch {
        // REST fallback failed — re-throw the original rate-limit error so
        // callers see a rate-limit error and take the correct fallback branch.
        if (lastError instanceof Error) throw lastError;
        throw new Error(String(lastError));
      }
    }
  }

  console.warn("Gh CLI rate limit retries exhausted, no REST fallback available");
  if (lastError instanceof Error) throw lastError;
  throw new Error(String(lastError));
}

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecCommand = "gh" | "git";

async function execCli(
  bin: ExecCommand,
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env: { ...process.env, ...env } } : {}),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`${bin} ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function gh(args: string[]): Promise<string> {
  return ghWithRetry(args);
}

async function ghInDir(args: string[], cwd: string): Promise<string> {
  return ghWithRetry(args, cwd);
}

/**
 * Map REST check-run conclusion/status to the GraphQL-style state string
 * used in `statusCheckRollup` entries.
 */
function mapCheckRunConclusionToState(
  conclusion: unknown,
  status: unknown,
): string {
  if (typeof conclusion === "string" && conclusion) {
    const c = conclusion.toUpperCase();
    if (c === "SUCCESS") return "SUCCESS";
    if (c === "FAILURE") return "FAILURE";
    if (c === "NEUTRAL") return "NEUTRAL";
    if (c === "CANCELLED") return "CANCELLED";
    if (c === "TIMED_OUT") return "TIMED_OUT";
    if (c === "ACTION_REQUIRED") return "ACTION_REQUIRED";
    if (c === "SKIPPED") return "SKIPPED";
    return c;
  }
  // No conclusion yet — map from status
  if (typeof status === "string") {
    const s = status.toUpperCase();
    if (s === "COMPLETED") return "SUCCESS";
    if (s === "IN_PROGRESS") return "IN_PROGRESS";
    if (s === "QUEUED") return "QUEUED";
    return s;
  }
  return "PENDING";
}

/**
 * Fetch all check-runs for a commit via the GitHub REST API using `gh api --paginate`.
 * Returns a statusCheckRollup-compatible array of entries with name, state, and detailsUrl.
 */
async function fetchCheckRunsViaRest(repo: string, sha: string, cwd?: string): Promise<unknown[]> {
  try {
    const raw = await execCli(
      "gh",
      ["api", `repos/${repo}/commits/${sha}/check-runs`, "--paginate"],
      cwd,
    );
    const data = JSON.parse(raw) as { check_runs?: unknown[] };
    return (data.check_runs ?? []).map((run: Record<string, unknown> | unknown) => {
      const r = run as Record<string, unknown>;
      return {
        name: r.name,
        state: mapCheckRunConclusionToState(r.conclusion, r.status),
        detailsUrl: r.html_url,
      };
    });
  } catch (err) {
    // Propagate errors so callers can fail-closed rather than treating
    // a fetch failure as "no checks" (which getMergeability treats as passing).
    throw new Error(
      `fetchCheckRunsViaRest: failed to fetch check-runs for ${repo}@${sha}: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Rate-limit fallback for getCIChecksFromStatusRollup:
 * Fetches head SHA from REST PR endpoint, then retrieves check-runs.
 */
async function getCIChecksFromStatusRollupViaRest(pr: PRInfo): Promise<CICheck[]> {
  // Errors propagate to the caller (getCISummary), which will fail-closed ("failing").
  const prRaw = await gh(["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`]);
  const prData = JSON.parse(prRaw) as { head?: { sha?: unknown } };
  const sha = typeof prData.head?.sha === "string" ? prData.head.sha : undefined;
  if (!sha) {
    throw new Error(`getCIChecksFromStatusRollupViaRest: could not determine head SHA for PR #${pr.number}`);
  }

  // fetchCheckRunsViaRest returns { name, state, detailsUrl } where state is
  // already a GraphQL-style string (via mapCheckRunConclusionToState).
  // Map state → CICheck["status"] via mapRawCheckStateToStatus.
  const rollup = await fetchCheckRunsViaRest(`${pr.owner}/${pr.repo}`, sha);
  return (rollup as Array<{ name?: unknown; state?: unknown; detailsUrl?: unknown }>)
    .map((entry): CICheck | null => {
      const name = typeof entry.name === "string" ? entry.name : null;
      if (!name) return null;
      const rawState = typeof entry.state === "string" ? entry.state : undefined;
      return {
        name,
        status: mapRawCheckStateToStatus(rawState),
        conclusion: rawState?.toUpperCase(),
        url: typeof entry.detailsUrl === "string" ? entry.detailsUrl : undefined,
      };
    })
    .filter((check): check is CICheck => check !== null);
}

async function git(args: string[], cwd: string): Promise<string> {
  return execCli("git", args, cwd);
}

function parseProjectRepo(projectRepo: string): [string, string] {
  const parts = projectRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${projectRepo}", expected "owner/repo"`);
  }
  return [parts[0], parts[1]];
}

function prInfoFromView(
  data: {
    number: number;
    url: string;
    title: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  },
  projectRepo: string,
): PRInfo {
  const [owner, repo] = parseProjectRepo(projectRepo);

  return {
    number: data.number,
    url: data.url,
    title: data.title,
    owner,
    repo,
    branch: data.headRefName,
    baseBranch: data.baseRefName,
    isDraft: data.isDraft,
  };
}

function isUnsupportedPrChecksJsonError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /pr checks/i.test(err.message) && /unknown json field/i.test(err.message);
}

function mapRawCheckStateToStatus(rawState: string | undefined): CICheck["status"] {
  const state = (rawState ?? "").toUpperCase();
  if (state === "IN_PROGRESS") return "running";
  if (
    state === "PENDING" ||
    state === "QUEUED" ||
    state === "REQUESTED" ||
    state === "WAITING" ||
    state === "EXPECTED"
  ) {
    return "pending";
  }
  if (state === "SUCCESS") return "passed";
  if (
    state === "FAILURE" ||
    state === "TIMED_OUT" ||
    state === "CANCELLED" ||
    state === "ACTION_REQUIRED" ||
    state === "ERROR"
  ) {
    return "failed";
  }
  if (
    state === "SKIPPED" ||
    state === "NEUTRAL" ||
    state === "STALE" ||
    state === "NOT_REQUIRED" ||
    state === "NONE" ||
    state === ""
  ) {
    return "skipped";
  }

  return "skipped";
}

async function getCIChecksFromStatusRollup(pr: PRInfo): Promise<CICheck[]> {
  let raw: string;
  try {
    raw = await gh([
      "pr",
      "view",
      String(pr.number),
      "--repo",
      repoFlag(pr),
      "--json",
      "statusCheckRollup",
    ]);
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    // Rate limit on gh pr view — fall back to REST check-runs via shared helper
    return getCIChecksFromStatusRollupViaRest(pr);
  }

  const data: { statusCheckRollup?: unknown[] } = JSON.parse(raw);
  const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];

  return rollup
    .map((entry): CICheck | null => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const name =
        (typeof row["name"] === "string" && row["name"]) ||
        (typeof row["context"] === "string" && row["context"]);
      if (!name) return null;

      const rawState =
        typeof row["conclusion"] === "string"
          ? row["conclusion"]
          : typeof row["state"] === "string"
            ? row["state"]
            : typeof row["status"] === "string"
              ? row["status"]
              : undefined;

      const url =
        (typeof row["link"] === "string" && row["link"]) ||
        (typeof row["detailsUrl"] === "string" && row["detailsUrl"]) ||
        (typeof row["targetUrl"] === "string" && row["targetUrl"]) ||
        undefined;

      const startedAtRaw =
        typeof row["startedAt"] === "string"
          ? row["startedAt"]
          : typeof row["createdAt"] === "string"
            ? row["createdAt"]
            : undefined;
      const completedAtRaw =
        typeof row["completedAt"] === "string" ? row["completedAt"] : undefined;

      const check: CICheck = {
        name,
        status: mapRawCheckStateToStatus(rawState),
        conclusion: typeof rawState === "string" ? rawState.toUpperCase() : undefined,
        startedAt: startedAtRaw ? new Date(startedAtRaw) : undefined,
        completedAt: completedAtRaw ? new Date(completedAtRaw) : undefined,
      };

      if (url) {
        check.url = url;
      }

      return check;
    })
    .filter((check): check is CICheck => check !== null);
}

function getGitHubWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/github",
    secretEnvVar: webhook?.secretEnvVar,
    signatureHeader: webhook?.signatureHeader ?? "x-hub-signature-256",
    eventHeader: webhook?.eventHeader ?? "x-github-event",
    deliveryHeader: webhook?.deliveryHeader ?? "x-github-delivery",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyGitHubSignature(
  body: string | Uint8Array,
  secret: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseGitHubRepository(payload: Record<string, unknown>) {
  const repository = payload["repository"];
  if (!repository || typeof repository !== "object") return undefined;
  const repo = repository as Record<string, unknown>;
  const ownerValue = repo["owner"];
  const ownerLogin =
    ownerValue && typeof ownerValue === "object"
      ? (ownerValue as Record<string, unknown>)["login"]
      : undefined;
  const owner = typeof ownerLogin === "string" ? ownerLogin : undefined;
  const name = typeof repo["name"] === "string" ? repo["name"] : undefined;
  if (!owner || !name) return undefined;
  return { owner, name };
}

function parseGitHubWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getGitHubWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseGitHubRepository(payload);
  const action = typeof payload["action"] === "string" ? payload["action"] : rawEventType;

  if (rawEventType === "pull_request") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: "pull_request",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp: parseWebhookTimestamp(pr["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "pull_request_review" || rawEventType === "pull_request_review_comment") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: rawEventType === "pull_request_review" ? "review" : "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp:
        rawEventType === "pull_request_review"
          ? parseWebhookTimestamp(
              (payload["review"] as Record<string, unknown> | undefined)?.["submitted_at"],
            )
          : parseWebhookTimestamp(
              (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
                (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
            ),
      data: payload,
    };
  }

  if (rawEventType === "issue_comment") {
    const issue = payload["issue"];
    if (!issue || typeof issue !== "object") return null;
    const issueRecord = issue as Record<string, unknown>;
    if (!("pull_request" in issueRecord)) return null;
    return {
      provider: "github",
      kind: "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof issueRecord["number"] === "number" ? issueRecord["number"] : undefined,
      timestamp: parseWebhookTimestamp(
        (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
          (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
      ),
      data: payload,
    };
  }

  if (rawEventType === "check_run" || rawEventType === "check_suite") {
    const check = payload[rawEventType] as Record<string, unknown> | undefined;
    const pullRequests = Array.isArray(check?.["pull_requests"])
      ? (check?.["pull_requests"] as Array<Record<string, unknown>>)
      : [];
    const firstPR = pullRequests[0];
    return {
      provider: "github",
      kind: "ci",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof firstPR?.["number"] === "number" ? firstPR["number"] : undefined,
      branch:
        typeof check?.["head_branch"] === "string"
          ? (check["head_branch"] as string)
          : typeof (check?.["check_suite"] as Record<string, unknown> | undefined)?.[
                "head_branch"
              ] === "string"
            ? ((check?.["check_suite"] as Record<string, unknown>)["head_branch"] as string)
            : undefined,
      sha: typeof check?.["head_sha"] === "string" ? (check["head_sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(check?.["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "status") {
    const branches = Array.isArray(payload["branches"])
      ? (payload["branches"] as Array<Record<string, unknown>>)
      : [];
    return {
      provider: "github",
      kind: "ci",
      action: typeof payload["state"] === "string" ? (payload["state"] as string) : action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(branches[0]?.["name"] ?? payload["ref"]),
      sha: typeof payload["sha"] === "string" ? (payload["sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(payload["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "push") {
    const headCommit =
      payload["head_commit"] && typeof payload["head_commit"] === "object"
        ? (payload["head_commit"] as Record<string, unknown>)
        : undefined;
    return {
      provider: "github",
      kind: "push",
      action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(payload["ref"]),
      sha: typeof payload["after"] === "string" ? (payload["after"] as string) : undefined,
      timestamp: parseWebhookTimestamp(headCommit?.["timestamp"] ?? payload["updated_at"]),
      data: payload,
    };
  }

  return {
    provider: "github",
    kind: "unknown",
    action,
    rawEventType,
    deliveryId,
    repository,
    timestamp: parseWebhookTimestamp(payload["updated_at"]),
    data: payload,
  };
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(): SCM {
  return {
    name: "github",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const config = getGitHubWebhookConfig(project);
      if (!config.enabled) {
        return { ok: false, reason: "Webhook is disabled for this project" };
      }
      if (request.method.toUpperCase() !== "POST") {
        return { ok: false, reason: "Webhook requests must use POST" };
      }
      if (
        config.maxBodyBytes !== undefined &&
        Buffer.byteLength(request.body, "utf8") > config.maxBodyBytes
      ) {
        return { ok: false, reason: "Webhook payload exceeds configured maxBodyBytes" };
      }

      const eventType = getWebhookHeader(request.headers, config.eventHeader);
      if (!eventType) {
        return { ok: false, reason: `Missing ${config.eventHeader} header` };
      }

      const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
      const secretName = config.secretEnvVar;
      if (!secretName) {
        return { ok: true, deliveryId, eventType };
      }

      const secret = process.env[secretName];
      if (!secret) {
        return { ok: false, reason: `Webhook secret env var ${secretName} is not configured` };
      }

      const signature = getWebhookHeader(request.headers, config.signatureHeader);
      if (!signature) {
        return { ok: false, reason: `Missing ${config.signatureHeader} header` };
      }

      if (!verifyGitHubSignature(request.rawBody ?? request.body, secret, signature)) {
        return {
          ok: false,
          reason: "Webhook signature verification failed",
          deliveryId,
          eventType,
        };
      }

      return { ok: true, deliveryId, eventType };
    },

    async parseWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookEvent | null> {
      const config = getGitHubWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseGitHubWebhookEvent(request, payload, config);
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;
      parseProjectRepo(project.repo);
      try {
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "1",
        ]);

        const prs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }> = JSON.parse(raw);

        if (prs.length === 0) return null;

        return prInfoFromView(prs[0], project.repo);
      } catch {
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      const raw = await gh([
        "pr",
        "view",
        reference,
        "--repo",
        project.repo,
        "--json",
        "number,url,title,headRefName,baseRefName,isDraft",
      ]);

      const data: {
        number: number;
        url: string;
        title: string;
        headRefName: string;
        baseRefName: string;
        isDraft: boolean;
      } = JSON.parse(raw);

      return prInfoFromView(data, project.repo);
    },

    async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
      await gh(["pr", "edit", String(pr.number), "--repo", repoFlag(pr), "--add-assignee", "@me"]);
    },

    async checkoutPR(pr: PRInfo, workspacePath: string): Promise<boolean> {
      const currentBranch = await git(["branch", "--show-current"], workspacePath);
      if (currentBranch === pr.branch) return false;

      const dirty = await git(["status", "--porcelain"], workspacePath);
      if (dirty) {
        throw new Error(
          `Workspace has uncommitted changes; cannot switch to PR branch "${pr.branch}" safely`,
        );
      }

      await ghInDir(["pr", "checkout", String(pr.number), "--repo", repoFlag(pr)], workspacePath);
      return true;
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      if (s === "CLOSED") return "closed";
      return "open";
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state,title,additions,deletions",
      ]);
      const data: {
        state: string;
        title: string;
        additions: number;
        deletions: number;
      } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      const state: PRState = s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
      return {
        state,
        title: data.title ?? "",
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,state,link,startedAt,completedAt",
        ]);

        const checks: Array<{
          name: string;
          state: string;
          link: string;
          startedAt: string;
          completedAt: string;
        }> = JSON.parse(raw);

        return checks.map((c) => {
          const state = c.state?.toUpperCase();

          return {
            name: c.name,
            status: mapRawCheckStateToStatus(state),
            url: c.link || undefined,
            conclusion: state || undefined,
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
            completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
          };
        });
      } catch (err) {
        if (isUnsupportedPrChecksJsonError(err)) {
          return getCIChecksFromStatusRollup(pr);
        }
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch (err) {
        // Rate limit errors are transient — try the status-rollup path first
        // (gh pr view with REST fallback) before giving up.
        if (isRateLimitError(err)) {
          try {
            checks = await getCIChecksFromStatusRollup(pr);
          } catch {
            // Secondary fallback also failed. Check merged/closed before
            // fail-closing — same as the non-rate-limit path below.
            try {
              const state = await this.getPRState(pr);
              if (state === "merged" || state === "closed") return "none";
            } catch {
              // Can't determine state; fall through to fail-closed.
            }
            return "failing";
          }
        } else {
          // Before fail-closing, check if the PR is merged/closed —
          // GitHub may not return check data for those, and reporting
          // "failing" for a merged PR is wrong.
          try {
            const state = await this.getPRState(pr);
            if (state === "merged" || state === "closed") return "none";
          } catch {
            // Can't determine state either; fall through to fail-closed.
          }
          // Fail closed for open PRs: report as failing rather than
          // "none" (which getMergeability treats as passing).
          return "failing";
        }
      }
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      // Only report passing if at least one check actually passed
      // (not all skipped)
      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data: {
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      } = JSON.parse(raw);

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviewDecision",
      ]);
      const data: { reviewDecision: string } = JSON.parse(raw);

      const d = (data.reviewDecision ?? "").toUpperCase();
      if (d === "APPROVED") return "approved";
      if (d === "CHANGES_REQUESTED") return "changes_requested";
      if (d === "REVIEW_REQUIRED") return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        // Use GraphQL with variables to get review threads with actual isResolved status
        const raw = await gh([
          "api",
          "graphql",
          "-f",
          `owner=${pr.owner}`,
          "-f",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
          "-f",
          `query=query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  nodes {
                    isResolved
                    comments(first: 1) {
                      nodes {
                        id
                        author { login }
                        body
                        path
                        line
                        url
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }`,
        ]);

        const data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    isResolved: boolean;
                    comments: {
                      nodes: Array<{
                        id: string;
                        author: { login: string } | null;
                        body: string;
                        path: string | null;
                        line: number | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const threads = data.data.repository.pullRequest.reviewThreads.nodes;

        return threads
          .filter((t) => {
            if (t.isResolved) return false; // only pending (unresolved) threads
            const c = t.comments.nodes[0];
            if (!c) return false; // skip threads with no comments
            const author = c.author?.login ?? "";
            return !BOT_AUTHORS.has(author);
          })
          .map((t) => {
            const c = t.comments.nodes[0];
            return {
              id: c.id,
              author: c.author?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
            };
          });
      } catch (err) {
        throw new Error("Failed to fetch pending comments", { cause: err });
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        const perPage = 100;
        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = [];

        for (let page = 1; ; page++) {
          const raw = await gh([
            "api",
            "--method",
            "GET",
            `repos/${repoFlag(pr)}/pulls/${pr.number}/comments?per_page=${perPage}&page=${page}`,
          ]);
          const pageComments: Array<{
            id: number;
            user: { login: string };
            body: string;
            path: string;
            line: number | null;
            original_line: number | null;
            created_at: string;
            html_url: string;
          }> = JSON.parse(raw);

          if (pageComments.length === 0) {
            break;
          }

          comments.push(...pageComments);
          if (pageComments.length < perPage) {
            break;
          }
        }

        return comments
          .filter((c) => BOT_AUTHORS.has(c.user?.login ?? ""))
          .map((c) => {
            // Determine severity from body content
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = c.body.toLowerCase();
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical") ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(c.id),
              botName: c.user?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? c.original_line ?? undefined,
              severity,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            };
          });
      } catch (err) {
        throw new Error("Failed to fetch automated comments", { cause: err });
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // First, check if the PR is merged
      // GitHub returns mergeable=null for merged PRs, which is not useful
      // Note: We only skip checks for merged PRs. Closed PRs still need accurate status.
      const state = await this.getPRState(pr);
      if (state === "merged") {
        // For merged PRs, return a clean result without querying mergeable status
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      // Fetch PR details with merge state
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "mergeable,reviewDecision,mergeStateStatus,isDraft",
      ]);

      const data: {
        mergeable: string;
        reviewDecision: string;
        mergeStateStatus: string;
        isDraft: boolean;
      } = JSON.parse(raw);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED") {
        blockers.push("Review required");
      }

      // Conflicts / merge state
      const mergeable = (data.mergeable ?? "").toUpperCase();
      const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
      const noConflicts = mergeable === "MERGEABLE";
      if (mergeable === "CONFLICTING") {
        blockers.push("Merge conflicts");
      } else if (mergeable === "UNKNOWN" || mergeable === "") {
        blockers.push("Merge status unknown (GitHub is computing)");
      }
      if (mergeState === "BEHIND") {
        blockers.push("Branch is behind base branch");
      } else if (mergeState === "BLOCKED") {
        blockers.push("Merge is blocked by branch protection");
      } else if (mergeState === "UNSTABLE") {
        blockers.push("Required checks are failing");
      }

      // Draft
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },

    /**
     * Batch fetch PR data for multiple PRs using GraphQL.
     * This is an optimization for the orchestrator polling loop.
     *
     * Instead of making 3 separate API calls for each PR (getPRState,
     * getCISummary, getReviewDecision), we fetch all data for all PRs
     * in one GraphQL query using aliases.
     *
     * This reduces API calls from N×3 to 1 (or a few if batching needed).
     */
    async enrichSessionsPRBatch(
      prs: PRInfo[],
      observer?: BatchObserver,
    ): Promise<Map<string, PREnrichmentData>> {
      return enrichSessionsPRBatchImpl(prs, observer);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;

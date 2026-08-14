import type {
  AOPullRequestReviewState,
  AOReviewRun,
  PullRequestSummary,
} from "@aoagents/cloud-client";
import type {
  PRDisplayTone,
  PRSummaryPart,
} from "@aoagents/product-ui";
import type {
  BoardPullRequestPresentation,
  InspectorReviewGroup,
  InspectorReviewRun,
  InspectorVerdict,
} from "@aoagents/product-ui";

const ciLabel: Record<string, { status: string; tone: PRDisplayTone }> = {
  passing: { status: "Passing", tone: "success" },
  failing: { status: "Failing", tone: "error" },
  pending: { status: "Running", tone: "neutral" },
  unknown: { status: "Unknown", tone: "passive" },
};

const reviewLabel: Record<string, { status: string; tone: PRDisplayTone }> = {
  none: { status: "No review", tone: "passive" },
  approved: { status: "Approved", tone: "success" },
  changes_requested: { status: "Changes requested", tone: "review" },
  review_required: { status: "Review required", tone: "warning" },
};

const mergeLabel: Record<string, { status: string; tone: PRDisplayTone }> = {
  mergeable: { status: "Mergeable", tone: "success" },
  conflicting: { status: "Conflicts", tone: "error" },
  blocked: { status: "Blocked", tone: "warning" },
  unstable: { status: "Unstable", tone: "warning" },
  unknown: { status: "Unknown", tone: "passive" },
};

export function pullRequestSummaryParts(pr: PullRequestSummary): PRSummaryPart[] {
  return [
    {
      key: "ci",
      label: "CI",
      links: [],
      ...(ciLabel[pr.ci.state] ?? ciLabel.unknown),
    },
    {
      key: "review",
      label: "Review",
      links: [],
      ...(reviewLabel[pr.review.decision] ?? reviewLabel.none),
    },
    {
      key: "merge",
      label: "Merge",
      links: [],
      ...(mergeLabel[pr.mergeability.state] ?? mergeLabel.unknown),
    },
  ];
}

export function toBoardPullRequest(pr: PullRequestSummary): BoardPullRequestPresentation {
  return { number: pr.number, state: pr.state, url: pr.htmlUrl || pr.url };
}

const runVerdictLabel: Record<string, InspectorVerdict> = {
  running: { label: "Reviewing…", tone: "running" },
  failed: { label: "Review failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

function reviewRunVerdict(run: AOReviewRun): InspectorVerdict {
  const byStatus = runVerdictLabel[run.status];
  if (byStatus) return byStatus;
  if (run.verdict === "approved") return { label: "Approved", tone: "success" };
  if (run.verdict === "changes_requested") {
    return { label: "Changes requested", tone: "danger" };
  }
  return { label: "Reviewed", tone: "neutral" };
}

function toInspectorReviewRun(run: AOReviewRun): InspectorReviewRun {
  return {
    body: run.body || undefined,
    createdAtLabel: new Date(run.createdAt).toLocaleString(),
    harness: run.harness || "AO",
    id: run.id,
    status: run.status,
    url: run.pullRequestUrl || null,
    verdict: reviewRunVerdict(run),
  };
}

export function toInspectorReviewGroups(
  reviews: AOPullRequestReviewState[],
): InspectorReviewGroup[] {
  return reviews.map((review) => {
    const runs = [review.latestRun, review.previousRun].filter(
      (run): run is AOReviewRun => Boolean(run),
    );
    return {
      ao: { runs: runs.map(toInspectorReviewRun) },
      meta: `#${review.pullRequestNumber}`,
      number: review.pullRequestNumber,
      title: review.title,
      verdict: review.latestRun ? reviewRunVerdict(review.latestRun) : undefined,
    };
  });
}

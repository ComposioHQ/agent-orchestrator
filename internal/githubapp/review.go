package githubapp

import (
	"context"
	"fmt"
	"strings"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

// triggerReview starts an AO-triggered review pass for a freshly raised pull
// request as its own dedicated agent process in the same sandbox that
// raised it (see OpenReviewTerminal) — not a message appended to that
// session's ongoing conversation. That sandbox is already checked out on
// the PR's branch, so this needs no new checkout mechanism. It is fenced by
// CreateReviewRun's (pull_request_id, target_sha) uniqueness, so calling it
// twice for the same commit is harmless.
//
// A review is a courtesy on top of an already-successful pull request, not
// a condition of it: any failure here is logged and swallowed rather than
// returned, so a review-triggering problem never turns a successful
// RaisePullRequest into a failed one.
func (s *Service) triggerReview(ctx context.Context, orgID, sessionID string, pr domain.PullRequest) {
	run, created, err := s.store.CreateReviewRun(ctx, orgID, pr.ID, sessionID, pr.HeadSHA)
	if err != nil {
		s.logger.Error("create review run", "error", err, "pull_request_id", pr.ID)
		return
	}
	if !created {
		return
	}
	if err := s.store.OpenReviewTerminal(ctx, orgID, sessionID, run.ID, reviewPrompt(run.ID, pr)); err != nil {
		s.logger.Error("open review terminal", "error", err, "pull_request_id", pr.ID, "review_run_id", run.ID)
	}
}

// reviewPrompt is the first (and only) input a fresh review terminal
// receives. Unlike a message appended to an ongoing conversation, this
// process has no memory of raising the PR — it starts knowing nothing but
// what's in this prompt and what it can see in the checked-out workspace,
// so it's told explicitly to look at the diff itself rather than assumed
// to already know what changed.
func reviewPrompt(reviewRunID string, pr domain.PullRequest) string {
	return fmt.Sprintf(
		"You are AO's automated reviewer for one pull request: %s, #%d: %q, "+
			"%s into %s. This is a fresh session with no prior context — you did not "+
			"write this change. Start by running `git diff %s...%s` (and `git log`, `git show` "+
			"as needed) in the current workspace to see exactly what changed, then review it "+
			"for correctness, quality, and bugs as a careful human reviewer would, not just a "+
			"summary of the diff.\n\n"+
			"When you are done, submit your verdict by POSTing to $AO_REVIEW_SOCKET: $AO_REVIEW_HELP\n\n"+
			"Use reviewRunId %q, verdict \"approved\" if the change looks correct and ready to merge, "+
			"or \"changes_requested\" if you found problems that should be fixed first, and a body "+
			"explaining your findings.",
		pr.Repository, pr.Number, pr.Title, pr.SourceBranch, pr.TargetBranch,
		pr.TargetBranch, pr.SourceBranch, reviewRunID,
	)
}

// SubmitReview records a review session's verdict on the pull request it
// was asked to review, posts it to GitHub as a comment (the same identity
// that raised the pull request cannot APPROVE or REQUEST_CHANGES its own
// PR — see CreatePullRequestReview), and marks the run delivered. It is the
// counterpart to triggerReview: the only way a review run's verdict ever
// gets recorded.
func (s *Service) SubmitReview(
	ctx context.Context,
	orgID, sessionID, reviewRunID string,
	result domain.SubmitReviewResult,
) (domain.ReviewRun, error) {
	if !result.Verdict.Valid() {
		return domain.ReviewRun{}, fmt.Errorf("%w: verdict must be approved or changes_requested", postgres.ErrInvalid)
	}
	body := strings.TrimSpace(result.Body)
	if body == "" {
		return domain.ReviewRun{}, fmt.Errorf("%w: a review body is required", postgres.ErrInvalid)
	}
	run, err := s.store.ReviewRunPullRequest(ctx, orgID, reviewRunID)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	if run.ReviewSessionID != sessionID {
		return domain.ReviewRun{}, postgres.ErrForbidden
	}
	if run.Status != contract.AOReviewRunRunning {
		return domain.ReviewRun{}, fmt.Errorf("%w: this review has already been resolved", postgres.ErrInvalid)
	}
	owner, repo, ok := strings.Cut(run.PullRequestRepository, "/")
	if !ok || owner == "" || repo == "" {
		return domain.ReviewRun{}, postgres.ErrInvalid
	}
	installationID, repositoryID, err := s.store.GitHubInstallationForRepository(ctx, orgID, run.PullRequestRepository)
	if err != nil {
		return s.failReview(ctx, orgID, sessionID, reviewRunID, err)
	}
	access, err := s.client.repositoryWriteToken(ctx, installationID, repositoryID)
	if err != nil {
		return s.failReview(ctx, orgID, sessionID, reviewRunID, err)
	}
	providerReviewID, err := s.client.CreatePullRequestReview(
		ctx, access.Token, owner, repo, run.PullRequestNumber, body,
	)
	if err != nil {
		return s.failReview(ctx, orgID, sessionID, reviewRunID, err)
	}
	delivered, err := s.store.CompleteAndDeliverReviewRun(
		ctx, orgID, reviewRunID, sessionID,
		domain.SubmitReviewResult{Verdict: result.Verdict, Body: body},
		formatProviderReviewID(providerReviewID),
	)
	if err != nil {
		return domain.ReviewRun{}, err
	}
	s.closeReviewTerminal(ctx, orgID, sessionID, reviewRunID)
	return delivered, nil
}

// failReview records a review run's failure and, best-effort, tears down
// the dedicated terminal OpenReviewTerminal started for it — its job is
// done whether the review succeeded or not. Returns the same (run, cause)
// shape SubmitReview's three failure sites already returned before this was
// factored out.
func (s *Service) failReview(
	ctx context.Context, orgID, sessionID, reviewRunID string, cause error,
) (domain.ReviewRun, error) {
	failed, failErr := s.store.FailReviewRun(ctx, orgID, reviewRunID, sessionID, cause.Error())
	s.closeReviewTerminal(ctx, orgID, sessionID, reviewRunID)
	if failErr == nil {
		return failed, cause
	}
	return domain.ReviewRun{}, cause
}

// closeReviewTerminal is best-effort cleanup: a failure here means the
// dedicated review process may linger in the sandbox until the session
// itself ends, not that the review's own outcome (already recorded) is
// wrong, so it's logged rather than propagated.
func (s *Service) closeReviewTerminal(ctx context.Context, orgID, sessionID, reviewRunID string) {
	if err := s.store.CloseReviewTerminal(ctx, orgID, sessionID, reviewRunID); err != nil {
		s.logger.Error("close review terminal", "error", err, "review_run_id", reviewRunID)
	}
}

func formatProviderReviewID(id int64) string {
	if id <= 0 {
		return ""
	}
	return fmt.Sprintf("%d", id)
}

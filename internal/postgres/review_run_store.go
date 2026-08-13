package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// reviewTerminalRequestTTL bounds how long a queued terminal.open/input/close
// worker-transport request waits to be claimed. The worker's poll loop is
// sub-second, so this is generous slack for a live worker, not a real
// deadline — if the worker is gone, the request simply expires unclaimed.
const reviewTerminalRequestTTL = 30 * time.Second

// CreateReviewRun records a new AO review pass against a pull request's
// current head commit, fenced by the (pull_request_id, target_sha) unique
// index so a review is never triggered twice against the same commit. When
// a run for this commit already exists, it is returned unchanged with
// created=false rather than erroring — the caller (a review trigger that
// may itself be retried) can treat both outcomes the same way: a run for
// this commit is now guaranteed to exist.
func (s *Store) CreateReviewRun(
	ctx context.Context,
	orgID, pullRequestID, reviewSessionID, targetSHA string,
) (run domain.ReviewRun, created bool, err error) {
	err = s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`INSERT INTO ao_review_runs (org_id, pull_request_id, review_session_id, target_sha)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (pull_request_id, target_sha) DO NOTHING
			RETURNING `+reviewRunColumns,
			orgID, pullRequestID, reviewSessionID, targetSHA,
		)
		var scanErr error
		run, scanErr = scanReviewRun(row)
		if errors.Is(scanErr, ErrNotFound) {
			row := tx.QueryRow(
				ctx,
				`SELECT `+reviewRunColumns+`
				FROM ao_review_runs
				WHERE org_id = $1 AND pull_request_id = $2 AND target_sha = $3`,
				orgID, pullRequestID, targetSHA,
			)
			run, scanErr = scanReviewRun(row)
			created = false
			return scanErr
		}
		if scanErr != nil {
			return scanErr
		}
		created = true
		_, err := tx.Exec(
			ctx,
			`UPDATE ao_pull_requests
			SET ao_review_state = 'running', updated_at = now()
			WHERE org_id = $1 AND id = $2`,
			orgID, pullRequestID,
		)
		return err
	})
	if err != nil {
		return domain.ReviewRun{}, false, normalizeConstraintError(err)
	}
	return run, created, nil
}

// OpenReviewTerminal starts an AO-triggered review as its own independent
// agent process in the same sandbox — not a message appended to the
// session's ongoing conversation. This mirrors the public agent-orchestrator
// repo's local desktop app, which reviews from a dedicated reviewer process
// that reuses the session's already-checked-out worktree rather than
// starting a fresh conversation on the same PTY or a fresh checkout (a
// fresh checkout would only have the target branch, not the PR's changes).
// Cloud has no shared local disk to spawn a second process onto, so the
// equivalent is a second terminal in the same sandbox: same harness binary,
// same working directory (the checkout the PR's branch already lives in,
// including whatever the worker's checkout-renewal loop has kept fresh),
// but its own undistracted conversation whose only job is this review.
//
// It has no idempotency key of its own because CreateReviewRun's
// (pull_request_id, target_sha) fence already guarantees a review is
// triggered at most once, so this is called at most once per commit too.
func (s *Store) OpenReviewTerminal(
	ctx context.Context,
	orgID, sessionID, reviewRunID, prompt string,
) error {
	terminalID := uuid.NewString()
	// The open and input requests are two separate transactions, not two
	// statements in one: within a single transaction, Postgres's now() (and
	// so every row's created_at) is frozen at transaction start, so both
	// rows would get an identical timestamp. ClaimWorkerRequest orders by
	// (created_at, id) — with tied timestamps that falls back to comparing
	// UUIDs, which is effectively random, so the input could be claimed
	// before the terminal it's meant for exists. Committing the open
	// request first guarantees it a strictly earlier created_at.
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		// A sandbox the idle-pause scanner paused between the PR-raising
		// push and this call has no live worker to open a terminal on —
		// widen it back to running so the very next scan (or the worker's
		// own reconnect) can catch up, the same wake createWorkerRequest's
		// callers rely on elsewhere.
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes
			SET desired_state = 'running', reconcile_after = now(), updated_at = now()
			WHERE session_id = $1 AND org_id = $2 AND desired_state = 'paused'`,
			sessionID, orgID,
		); err != nil {
			return err
		}
		openPayload, err := json.Marshal(worker.TerminalCommand{TerminalID: terminalID, Kind: "agent"})
		if err != nil {
			return err
		}
		if _, err := createWorkerRequest(
			ctx, tx, orgID, sessionID, "terminal.open", openPayload, reviewTerminalRequestTTL,
		); err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`UPDATE ao_review_runs SET review_terminal_id = $3 WHERE org_id = $1 AND id = $2`,
			orgID, reviewRunID, terminalID,
		)
		return err
	})
	if err != nil {
		return err
	}
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		inputPayload, err := json.Marshal(worker.TerminalCommand{
			TerminalID: terminalID, Data: []byte(prompt + "\r"),
		})
		if err != nil {
			return err
		}
		_, err = createWorkerRequest(
			ctx, tx, orgID, sessionID, "terminal.input", inputPayload, reviewTerminalRequestTTL,
		)
		return err
	})
}

// CloseReviewTerminal tears down the dedicated process OpenReviewTerminal
// started, once a review run has resolved (delivered or failed), so it
// doesn't linger as an unattended live process in the sandbox. A worker
// that's already gone (sandbox stopped/paused since) has nothing to close,
// so that specific failure is treated as success rather than surfaced.
func (s *Store) CloseReviewTerminal(ctx context.Context, orgID, sessionID, reviewRunID string) error {
	return s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var terminalID *string
		if err := tx.QueryRow(
			ctx,
			`SELECT review_terminal_id FROM ao_review_runs WHERE org_id = $1 AND id = $2`,
			orgID, reviewRunID,
		).Scan(&terminalID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil
			}
			return err
		}
		if terminalID == nil {
			return nil
		}
		payload, err := json.Marshal(worker.TerminalCommand{TerminalID: *terminalID})
		if err != nil {
			return err
		}
		_, err = createWorkerRequest(ctx, tx, orgID, sessionID, "terminal.close", payload, reviewTerminalRequestTTL)
		if errors.Is(err, ErrWorkerUnavailable) {
			return nil
		}
		return err
	})
}

// CompleteAndDeliverReviewRun records a review session's verdict and marks
// it delivered to GitHub in one step — called only after the GitHub review
// API call itself has already succeeded, the same "GitHub first, then the
// durable record" ordering CreatePullRequestRecord uses. It is fenced by
// reviewSessionID: only the session that owns this run (the one
// CreateReviewRun recorded as review_session_id) can complete it, and only
// while it is still running, so a stale retry or another session's worker
// can never overwrite a verdict that already landed. The pull request's
// ao_review_state is only advanced if its head_sha still matches the run's
// target_sha — if the PR moved on to a new commit while this review was in
// flight, the newer state (set by the next CreateReviewRun) must win.
func (s *Store) CompleteAndDeliverReviewRun(
	ctx context.Context,
	orgID, reviewRunID, reviewSessionID string,
	result domain.SubmitReviewResult,
	providerReviewID string,
) (domain.ReviewRun, error) {
	var run domain.ReviewRun
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`UPDATE ao_review_runs
			SET status = 'delivered', verdict = $4, body = $5, provider_review_id = $6,
				completed_at = now(), delivered_at = now()
			WHERE org_id = $1 AND id = $2 AND review_session_id = $3 AND status = 'running'
			RETURNING `+reviewRunColumns,
			orgID, reviewRunID, reviewSessionID, string(result.Verdict), result.Body, providerReviewID,
		)
		var err error
		run, err = scanReviewRun(row)
		if err != nil {
			return err
		}
		aoReviewState := "up_to_date"
		if result.Verdict == contract.AOReviewVerdictChangesRequested {
			aoReviewState = "changes_requested"
		}
		_, err = tx.Exec(
			ctx,
			`UPDATE ao_pull_requests
			SET ao_review_state = $3, updated_at = now()
			WHERE org_id = $1 AND id = $2 AND head_sha = $4`,
			orgID, run.PullRequestID, aoReviewState, run.TargetSHA,
		)
		return err
	})
	if err != nil {
		return domain.ReviewRun{}, normalizeConstraintError(err)
	}
	return run, nil
}

// FailReviewRun records that a review pass could not be delivered and
// releases the pull request back to needing review, so a failed automated
// pass never leaves ao_review_state stuck on "running" forever. Fenced the
// same way CompleteAndDeliverReviewRun is: only the owning session, only
// while still running.
func (s *Store) FailReviewRun(
	ctx context.Context,
	orgID, reviewRunID, reviewSessionID, lastError string,
) (domain.ReviewRun, error) {
	var run domain.ReviewRun
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`UPDATE ao_review_runs
			SET status = 'failed', last_error = $4, completed_at = now()
			WHERE org_id = $1 AND id = $2 AND review_session_id = $3 AND status = 'running'
			RETURNING `+reviewRunColumns,
			orgID, reviewRunID, reviewSessionID, lastError,
		)
		var err error
		run, err = scanReviewRun(row)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`UPDATE ao_pull_requests
			SET ao_review_state = 'needs_review', updated_at = now()
			WHERE org_id = $1 AND id = $2 AND head_sha = $3`,
			orgID, run.PullRequestID, run.TargetSHA,
		)
		return err
	})
	if err != nil {
		return domain.ReviewRun{}, normalizeConstraintError(err)
	}
	return run, nil
}

// ReviewRunPullRequest returns one review run joined with the identifying
// fields of the pull request it belongs to, so a verdict submission can
// mint a GitHub token and post the review without a second round trip.
func (s *Store) ReviewRunPullRequest(
	ctx context.Context,
	orgID, reviewRunID string,
) (domain.ReviewRunPullRequest, error) {
	var out domain.ReviewRunPullRequest
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`SELECT run.id, run.org_id, run.pull_request_id, run.review_session_id,
				run.target_sha, run.status, run.verdict, run.body,
				run.provider_review_id, run.last_error, run.created_at,
				run.completed_at, run.delivered_at,
				pr.provider, pr.repository, pr.number, pr.url, pr.title, pr.ao_review_state
			FROM ao_review_runs run
			JOIN ao_pull_requests pr ON pr.org_id = run.org_id AND pr.id = run.pull_request_id
			WHERE run.org_id = $1 AND run.id = $2`,
			orgID, reviewRunID,
		)
		var status, verdict, aoReviewState string
		if err := row.Scan(
			&out.ID, &out.OrgID, &out.PullRequestID, &out.ReviewSessionID,
			&out.TargetSHA, &status, &verdict, &out.Body,
			&out.ProviderReviewID, &out.LastError, &out.CreatedAt,
			&out.CompletedAt, &out.DeliveredAt,
			&out.PullRequestProvider, &out.PullRequestRepository, &out.PullRequestNumber,
			&out.PullRequestURL, &out.PullRequestTitle, &aoReviewState,
		); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrNotFound
			}
			return fmt.Errorf("scan review run pull request: %w", err)
		}
		out.Status = contract.AOReviewRunStatus(status)
		out.Verdict = contract.AOReviewVerdict(verdict)
		out.PullRequestAOReviewState = contract.AOReviewState(aoReviewState)
		return nil
	})
	if err != nil {
		return domain.ReviewRunPullRequest{}, err
	}
	return out, nil
}

// ListReviewRunsBySession returns every AO review run for pull requests a
// session has raised, most recent first, each joined with its pull
// request's identity — the read side a session's review-state view groups
// by pull request to show AO's review history per PR.
func (s *Store) ListReviewRunsBySession(
	ctx context.Context,
	principal domain.Principal,
	orgID, sessionID string,
) ([]domain.ReviewRunPullRequest, error) {
	var out []domain.ReviewRunPullRequest
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT run.id, run.org_id, run.pull_request_id, run.review_session_id,
				run.target_sha, run.status, run.verdict, run.body,
				run.provider_review_id, run.last_error, run.created_at,
				run.completed_at, run.delivered_at,
				pr.provider, pr.repository, pr.number, pr.url, pr.title, pr.ao_review_state
			FROM ao_review_runs run
			JOIN ao_pull_requests pr ON pr.org_id = run.org_id AND pr.id = run.pull_request_id
			WHERE run.org_id = $1 AND pr.session_id = $2
			ORDER BY run.pull_request_id, run.created_at DESC`,
			orgID, sessionID,
		)
		if err != nil {
			return fmt.Errorf("list review runs: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var run domain.ReviewRunPullRequest
			var status, verdict, aoReviewState string
			if err := rows.Scan(
				&run.ID, &run.OrgID, &run.PullRequestID, &run.ReviewSessionID,
				&run.TargetSHA, &status, &verdict, &run.Body,
				&run.ProviderReviewID, &run.LastError, &run.CreatedAt,
				&run.CompletedAt, &run.DeliveredAt,
				&run.PullRequestProvider, &run.PullRequestRepository, &run.PullRequestNumber,
				&run.PullRequestURL, &run.PullRequestTitle, &aoReviewState,
			); err != nil {
				return fmt.Errorf("scan review run: %w", err)
			}
			run.Status = contract.AOReviewRunStatus(status)
			run.Verdict = contract.AOReviewVerdict(verdict)
			run.PullRequestAOReviewState = contract.AOReviewState(aoReviewState)
			out = append(out, run)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

const reviewRunColumns = `id, org_id, pull_request_id, review_session_id, target_sha,
	status, verdict, body, provider_review_id, last_error, created_at, completed_at, delivered_at`

type reviewRunRow interface {
	Scan(dest ...any) error
}

func scanReviewRun(row reviewRunRow) (domain.ReviewRun, error) {
	var run domain.ReviewRun
	var status, verdict string
	err := row.Scan(
		&run.ID, &run.OrgID, &run.PullRequestID, &run.ReviewSessionID, &run.TargetSHA,
		&status, &verdict, &run.Body, &run.ProviderReviewID, &run.LastError,
		&run.CreatedAt, &run.CompletedAt, &run.DeliveredAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ReviewRun{}, ErrNotFound
	}
	if err != nil {
		return domain.ReviewRun{}, fmt.Errorf("scan review run: %w", err)
	}
	run.Status = contract.AOReviewRunStatus(status)
	run.Verdict = contract.AOReviewVerdict(verdict)
	return run, nil
}

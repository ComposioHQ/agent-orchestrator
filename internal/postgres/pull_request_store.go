package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/jackc/pgx/v5"
)

const pullRequestColumns = `id, org_id, session_id, provider, repository, author, number, url, title,
	state, draft, head_sha, source_branch, target_branch, additions, deletions, changed_files,
	ci_state, review_state, mergeability, checks, claimed_by_session_id, claimed_at, released_at,
	ao_review_state, observed_at, created_at, updated_at`

// CreatePullRequestRecord persists a pull request AO Cloud raised on GitHub's
// behalf. It is called only after the GitHub API call itself has already
// succeeded — this durably records something that verifiably exists on
// GitHub, it is not an intent to create one. A freshly raised pull request is
// never a draft, so state is always the raw GitHub "open" value. GitHub
// computes additions/deletions/changed_files asynchronously and may return
// zeroes for them on the create response itself — the next status refresh
// (RefreshPullRequestStatus) corrects them once GitHub has caught up.
func (s *Store) CreatePullRequestRecord(
	ctx context.Context,
	orgID, sessionID string,
	provider, repository, author string,
	number int,
	url, sourceBranch, targetBranch, headSHA, title string,
	additions, deletions, changedFiles int,
) (domain.PullRequest, error) {
	var record domain.PullRequest
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		record, err = scanPullRequest(tx.QueryRow(
			ctx,
			`INSERT INTO ao_pull_requests (
				org_id, session_id, provider, repository, author, number, url, title,
				state, head_sha, source_branch, target_branch, additions, deletions, changed_files
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			RETURNING `+pullRequestColumns,
			orgID, sessionID, provider, repository, author, number, url, title,
			string(contract.PRStateOpen), headSHA, sourceBranch, targetBranch,
			additions, deletions, changedFiles,
		))
		return err
	})
	if err != nil {
		return domain.PullRequest{}, normalizeConstraintError(err)
	}
	return record, nil
}

// GetPullRequest returns one pull request by its durable ID.
func (s *Store) GetPullRequest(
	ctx context.Context,
	orgID, pullRequestID string,
) (domain.PullRequest, error) {
	var record domain.PullRequest
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		record, err = scanPullRequest(tx.QueryRow(
			ctx,
			`SELECT `+pullRequestColumns+`
			FROM ao_pull_requests
			WHERE org_id = $1 AND id = $2`,
			orgID, pullRequestID,
		))
		return err
	})
	if err != nil {
		return domain.PullRequest{}, err
	}
	return record, nil
}

// ListPullRequestsBySession returns every pull request a session has raised,
// most recently created first. It verifies the caller belongs to orgID, so
// it is the version to call from a user-facing request; control-plane code
// with no principal should query ao_pull_requests directly instead.
func (s *Store) ListPullRequestsBySession(
	ctx context.Context,
	principal domain.Principal,
	orgID, sessionID string,
) ([]domain.PullRequest, error) {
	var records []domain.PullRequest
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT `+pullRequestColumns+`
			FROM ao_pull_requests
			WHERE org_id = $1 AND session_id = $2
			ORDER BY created_at DESC`,
			orgID, sessionID,
		)
		if err != nil {
			return fmt.Errorf("list pull requests: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			record, err := scanPullRequest(rows)
			if err != nil {
				return err
			}
			records = append(records, record)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return records, nil
}

// PRFactsBySession returns pull-request facts for every session in
// sessionIDs, grouped by session ID, in one round trip — the input
// contract.DeriveStatus needs to resolve a session's display status to a
// PR-lifecycle value (pr_open, ci_failed, review_pending,
// changes_requested, approved, mergeable, merged), the same way the local
// desktop app's ListPRFactsForSession backs its own status derivation.
//
// orgID is trusted here rather than re-verified against a principal: every
// caller already verified the caller may see this org's sessions — via
// withTenant on the session query this supplements, or a worker epoch/
// claims check for the orchestrator-child listing path, which has no
// principal at all — before reaching this supplementary fetch.
func (s *Store) PRFactsBySession(
	ctx context.Context,
	orgID string,
	sessionIDs []string,
) (map[string][]contract.PRFacts, error) {
	facts := make(map[string][]contract.PRFacts)
	if len(sessionIDs) == 0 {
		return facts, nil
	}
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT session_id, url, state, draft, source_branch, target_branch,
				ci_state, review_state, mergeability
			FROM ao_pull_requests
			WHERE org_id = $1 AND session_id = ANY($2)`,
			orgID, sessionIDs,
		)
		if err != nil {
			return fmt.Errorf("list pull request facts: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var sessionID, url, state, sourceBranch, targetBranch string
			var ciState, reviewState, mergeability string
			var draft bool
			if err := rows.Scan(
				&sessionID, &url, &state, &draft, &sourceBranch, &targetBranch,
				&ciState, &reviewState, &mergeability,
			); err != nil {
				return fmt.Errorf("scan pull request facts: %w", err)
			}
			prState := contract.PRState(state)
			facts[sessionID] = append(facts[sessionID], contract.PRFacts{
				URL:          url,
				Draft:        draft,
				Merged:       prState == contract.PRStateMerged,
				Closed:       prState == contract.PRStateClosed,
				CI:           contract.CIState(ciState),
				Review:       contract.ReviewDecision(reviewState),
				Mergeability: contract.Mergeability(mergeability),
				SourceBranch: sourceBranch,
				TargetBranch: targetBranch,
			})
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return facts, nil
}

// OpenPullRequestRefs lists every open pull request across every
// organization, for the background status poller to refresh. It runs with
// the control-plane service context rather than a single org's, the same way
// RunningSandboxSessions does for the idle-pause scanner: the poller has no
// user principal and must scan across tenants, but every write that follows
// still goes through withOrg so row-level security confines it again.
func (s *Store) OpenPullRequestRefs(ctx context.Context) ([]domain.PullRequestRef, error) {
	var refs []domain.PullRequestRef
	err := s.withService(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT id, org_id, provider, repository, number
			FROM ao_pull_requests
			WHERE state = 'open'`,
		)
		if err != nil {
			return fmt.Errorf("list open pull requests: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var ref domain.PullRequestRef
			if err := rows.Scan(&ref.ID, &ref.OrgID, &ref.Provider, &ref.Repository, &ref.Number); err != nil {
				return err
			}
			refs = append(refs, ref)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return refs, nil
}

// UpdatePullRequestObservation applies a freshly fetched GitHub snapshot over
// a pull request's durable record.
func (s *Store) UpdatePullRequestObservation(
	ctx context.Context,
	orgID, pullRequestID string,
	observation domain.PullRequestObservation,
) (domain.PullRequest, error) {
	state := observation.State
	if state == contract.PRStateDraft {
		state = contract.PRStateOpen
	}
	var record domain.PullRequest
	err := s.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		var err error
		record, err = scanPullRequest(tx.QueryRow(
			ctx,
			`UPDATE ao_pull_requests
			SET state = $3, draft = $4, head_sha = $5, additions = $6, deletions = $7,
				changed_files = $8, ci_state = $9, review_state = $10, mergeability = $11,
				observed_at = now(), updated_at = now()
			WHERE org_id = $1 AND id = $2
			RETURNING `+pullRequestColumns,
			orgID, pullRequestID,
			string(state), observation.Draft, observation.HeadSHA,
			observation.Additions, observation.Deletions, observation.ChangedFiles,
			string(observation.CIState), string(observation.ReviewState), string(observation.Mergeability),
		))
		return err
	})
	if err != nil {
		return domain.PullRequest{}, normalizeConstraintError(err)
	}
	return record, nil
}

type pullRequestRow interface {
	Scan(dest ...any) error
}

func scanPullRequest(row pullRequestRow) (domain.PullRequest, error) {
	var record domain.PullRequest
	var state, reviewState, mergeability, ciState, aoReviewState string
	err := row.Scan(
		&record.ID, &record.OrgID, &record.SessionID, &record.Provider, &record.Repository,
		&record.Author, &record.Number, &record.URL, &record.Title, &state, &record.Draft, &record.HeadSHA,
		&record.SourceBranch, &record.TargetBranch, &record.Additions, &record.Deletions, &record.ChangedFiles,
		&ciState, &reviewState, &mergeability,
		&record.Checks, &record.ClaimedBySessionID, &record.ClaimedAt, &record.ReleasedAt,
		&aoReviewState, &record.ObservedAt, &record.CreatedAt, &record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.PullRequest{}, ErrNotFound
	}
	if err != nil {
		return domain.PullRequest{}, fmt.Errorf("scan pull request: %w", err)
	}
	record.State = contract.PRState(state)
	if record.Draft && record.State == contract.PRStateOpen {
		record.State = contract.PRStateDraft
	}
	record.CIState = contract.CIState(ciState)
	record.ReviewState = contract.ReviewDecision(reviewState)
	record.Mergeability = contract.Mergeability(mergeability)
	record.AOReviewState = contract.AOReviewState(aoReviewState)
	return record, nil
}

package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// Review mutations are canonical SQL operations; database triggers own CDC.
var _ ports.ReviewRunStore = (*Store)(nil)

const productReviewColumns = `id, session_id, project_id, harness, pr_url,
 reviewer_handle_id, agent_session_id, created_at, updated_at`

const productReviewRunColumns = `id, review_id, session_id, batch_id, harness,
 trigger_source, pr_url, target_sha, status, verdict, body, github_review_id,
 created_at, delivered_at, auto_inject_review`

func (s *Store) UpsertReview(ctx context.Context, review domain.Review) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		_, err := tx.Exec(ctx, `INSERT INTO ao_reviews(
			org_id,owner_user_id,id,session_id,project_id,harness,pr_url,reviewer_handle_id,
			agent_session_id,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT(org_id,owner_user_id,session_id,harness) DO UPDATE SET
				project_id=EXCLUDED.project_id,pr_url=EXCLUDED.pr_url,
				reviewer_handle_id=EXCLUDED.reviewer_handle_id,
				agent_session_id=CASE WHEN EXCLUDED.agent_session_id<>'' THEN EXCLUDED.agent_session_id ELSE ao_reviews.agent_session_id END,
				updated_at=EXCLUDED.updated_at`,
			id.OrgID, id.UserID, review.ID, review.SessionID, review.ProjectID, review.Harness,
			review.PRURL, review.ReviewerHandleID, review.AgentSessionID, review.CreatedAt.UTC(), review.UpdatedAt.UTC())
		return normalizeError(err)
	})
}

func (s *Store) GetReviewBySession(ctx context.Context, sessionID domain.SessionID) (domain.Review, bool, error) {
	return s.getProductReview(ctx, `session_id=$3 ORDER BY updated_at DESC,created_at DESC,id DESC LIMIT 1`, sessionID)
}

func (s *Store) GetReviewBySessionAndHarness(ctx context.Context, sessionID domain.SessionID, harness domain.ReviewerHarness) (domain.Review, bool, error) {
	return s.getProductReview(ctx, `session_id=$3 AND harness=$4`, sessionID, harness)
}

func (s *Store) GetReviewByID(ctx context.Context, reviewID string) (domain.Review, bool, error) {
	return s.getProductReview(ctx, `id=$3`, reviewID)
}

func (s *Store) getProductReview(ctx context.Context, predicate string, args ...any) (domain.Review, bool, error) {
	var review domain.Review
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		queryArgs := append([]any{id.OrgID, id.UserID}, args...)
		return tx.QueryRow(ctx, `SELECT `+productReviewColumns+` FROM ao_reviews
			WHERE org_id=$1 AND owner_user_id=$2 AND `+predicate, queryArgs...).Scan(
			&review.ID, &review.SessionID, &review.ProjectID, &review.Harness, &review.PRURL,
			&review.ReviewerHandleID, &review.AgentSessionID, &review.CreatedAt, &review.UpdatedAt)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Review{}, false, nil
	}
	if err != nil {
		return domain.Review{}, false, fmt.Errorf("get review: %w", normalizeError(err))
	}
	return review, true, nil
}

func (s *Store) ListReviewsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.Review, error) {
	var reviews []domain.Review
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		rows, err := tx.Query(ctx, `SELECT `+productReviewColumns+` FROM ao_reviews
			WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3
			ORDER BY updated_at DESC,created_at DESC,id DESC`, id.OrgID, id.UserID, sessionID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var review domain.Review
			if err := rows.Scan(&review.ID, &review.SessionID, &review.ProjectID, &review.Harness, &review.PRURL,
				&review.ReviewerHandleID, &review.AgentSessionID, &review.CreatedAt, &review.UpdatedAt); err != nil {
				return err
			}
			reviews = append(reviews, review)
		}
		return rows.Err()
	})
	return reviews, normalizeError(err)
}

func (s *Store) ClearReviewerHandle(ctx context.Context, sessionID domain.SessionID) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		_, err := tx.Exec(ctx, `UPDATE ao_reviews SET reviewer_handle_id='',updated_at=now()
			WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3`, id.OrgID, id.UserID, sessionID)
		return normalizeError(err)
	})
}

func (s *Store) ClearReviewerHandleByHarness(ctx context.Context, sessionID domain.SessionID, harness domain.ReviewerHarness) error {
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		_, err := tx.Exec(ctx, `UPDATE ao_reviews SET reviewer_handle_id='',updated_at=now()
			WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 AND harness=$4`, id.OrgID, id.UserID, sessionID, harness)
		return normalizeError(err)
	})
}

func (s *Store) UpdateReviewAgentSessionID(ctx context.Context, reviewID, agentSessionID string) (bool, error) {
	var updated bool
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		result, err := tx.Exec(ctx, `UPDATE ao_reviews SET agent_session_id=$4,updated_at=now()
			WHERE org_id=$1 AND owner_user_id=$2 AND id=$3`, id.OrgID, id.UserID, reviewID, agentSessionID)
		updated = result.RowsAffected() > 0
		return normalizeError(err)
	})
	return updated, err
}

func (s *Store) InsertReviewRun(ctx context.Context, run domain.ReviewRun) error {
	if run.TriggerSource == "" {
		run.TriggerSource = domain.ReviewTriggerManual
	}
	if run.Status == "" {
		run.Status = domain.ReviewRunRunning
	}
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		_, err := tx.Exec(ctx, `INSERT INTO ao_review_runs(
			org_id,owner_user_id,id,review_id,session_id,batch_id,harness,trigger_source,pr_url,
			target_sha,status,verdict,body,github_review_id,created_at,delivered_at,auto_inject_review)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
			id.OrgID, id.UserID, run.ID, run.ReviewID, run.SessionID, run.BatchID, run.Harness,
			run.TriggerSource, run.PRURL, run.TargetSHA, run.Status, run.Verdict, run.Body,
			run.GithubReviewID, run.CreatedAt.UTC(), run.DeliveredAt, run.AutoInjectReview)
		return err
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return fmt.Errorf("insert review run for session %s pr %s sha %s: %w", run.SessionID, run.PRURL, run.TargetSHA, domain.ErrDuplicateReviewRun)
	}
	return normalizeError(err)
}

func (s *Store) UpdateReviewRunResult(ctx context.Context, runID string, status domain.ReviewRunStatus, verdict domain.ReviewVerdict, body, githubReviewID string, autoInjectReview bool) (bool, error) {
	return s.updateProductReviewRuns(ctx, `SET status=$4,verdict=$5,body=$6,github_review_id=$7,auto_inject_review=$8
		WHERE org_id=$1 AND owner_user_id=$2 AND id=$3 AND status='running'`, runID, status, verdict, body, githubReviewID, autoInjectReview)
}

func (s *Store) SupersedeStaleRunningReviewRuns(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA, body string) (int64, error) {
	return s.execProductReviewRunUpdate(ctx, `UPDATE ao_review_runs SET status='failed',body=$6
		WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 AND pr_url=$4 AND target_sha<>$5
		AND status='running' AND verdict=''`, sessionID, prURL, targetSHA, body)
}

func (s *Store) CancelRunningReviewRunsBySession(ctx context.Context, sessionID domain.SessionID, body string) (int64, error) {
	return s.execProductReviewRunUpdate(ctx, `UPDATE ao_review_runs SET status='cancelled',body=$4
		WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 AND status='running' AND verdict=''`, sessionID, body)
}

func (s *Store) CancelRunningReviewRunsBySessionAndHarness(ctx context.Context, sessionID domain.SessionID, harness domain.ReviewerHarness, body string) (int64, error) {
	return s.execProductReviewRunUpdate(ctx, `UPDATE ao_review_runs SET status='cancelled',body=$5
		WHERE org_id=$1 AND owner_user_id=$2 AND session_id=$3 AND harness=$4
		AND status='running' AND verdict=''`, sessionID, harness, body)
}

func (s *Store) MarkReviewRunDelivered(ctx context.Context, runID string, deliveredAt time.Time) (bool, error) {
	return s.updateProductReviewRuns(ctx, `SET status='delivered',delivered_at=$4
		WHERE org_id=$1 AND owner_user_id=$2 AND id=$3 AND status='complete' AND delivered_at IS NULL`, runID, deliveredAt.UTC())
}

func (s *Store) updateProductReviewRuns(ctx context.Context, clause string, args ...any) (bool, error) {
	count, err := s.execProductReviewRunUpdate(ctx, `UPDATE ao_review_runs `+clause, args...)
	return count > 0, err
}

func (s *Store) execProductReviewRunUpdate(ctx context.Context, query string, args ...any) (int64, error) {
	var count int64
	err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, id tenant.Identity) error {
		queryArgs := append([]any{id.OrgID, id.UserID}, args...)
		result, err := tx.Exec(ctx, query, queryArgs...)
		count = result.RowsAffected()
		return normalizeError(err)
	})
	return count, err
}

func (s *Store) GetReviewRun(ctx context.Context, runID string) (domain.ReviewRun, bool, error) {
	return s.getProductReviewRun(ctx, `id=$3`, runID)
}

func (s *Store) GetReviewRunBySessionPRAndSHA(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string) (domain.ReviewRun, bool, error) {
	return s.getProductReviewRun(ctx, `session_id=$3 AND pr_url=$4 AND target_sha=$5 ORDER BY created_at DESC,id DESC LIMIT 1`, sessionID, prURL, targetSHA)
}

func (s *Store) GetReviewRunBySessionPRSHAAndHarness(ctx context.Context, sessionID domain.SessionID, prURL, targetSHA string, harness domain.ReviewerHarness) (domain.ReviewRun, bool, error) {
	return s.getProductReviewRun(ctx, `session_id=$3 AND pr_url=$4 AND target_sha=$5 AND harness=$6 ORDER BY created_at DESC,id DESC LIMIT 1`, sessionID, prURL, targetSHA, harness)
}

func (s *Store) getProductReviewRun(ctx context.Context, predicate string, args ...any) (domain.ReviewRun, bool, error) {
	var run domain.ReviewRun
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		queryArgs := append([]any{id.OrgID, id.UserID}, args...)
		return scanProductReviewRun(tx.QueryRow(ctx, `SELECT `+productReviewRunColumns+` FROM ao_review_runs
			WHERE org_id=$1 AND owner_user_id=$2 AND `+predicate, queryArgs...), &run)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ReviewRun{}, false, nil
	}
	if err != nil {
		return domain.ReviewRun{}, false, fmt.Errorf("get review run: %w", normalizeError(err))
	}
	return run, true, nil
}

func (s *Store) ListReviewRunsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.ReviewRun, error) {
	return s.listProductReviewRuns(ctx, `session_id=$3 ORDER BY created_at DESC,id DESC`, sessionID)
}

func (s *Store) ListRunningReviewRunsBySession(ctx context.Context, sessionID domain.SessionID) ([]domain.ReviewRun, error) {
	return s.listProductReviewRuns(ctx, `session_id=$3 AND status='running' AND verdict='' ORDER BY created_at DESC,id DESC`, sessionID)
}

func (s *Store) ListReviewRunsByBatch(ctx context.Context, sessionID domain.SessionID, batchID string) ([]domain.ReviewRun, error) {
	return s.listProductReviewRuns(ctx, `session_id=$3 AND batch_id=$4 ORDER BY created_at,id`, sessionID, batchID)
}

func (s *Store) listProductReviewRuns(ctx context.Context, predicate string, args ...any) ([]domain.ReviewRun, error) {
	var runs []domain.ReviewRun
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, id tenant.Identity) error {
		queryArgs := append([]any{id.OrgID, id.UserID}, args...)
		rows, err := tx.Query(ctx, `SELECT `+productReviewRunColumns+` FROM ao_review_runs
			WHERE org_id=$1 AND owner_user_id=$2 AND `+predicate, queryArgs...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var run domain.ReviewRun
			if err := scanProductReviewRun(rows, &run); err != nil {
				return err
			}
			runs = append(runs, run)
		}
		return rows.Err()
	})
	return runs, normalizeError(err)
}

type productReviewRunScanner interface {
	Scan(...any) error
}

func scanProductReviewRun(row productReviewRunScanner, run *domain.ReviewRun) error {
	return row.Scan(&run.ID, &run.ReviewID, &run.SessionID, &run.BatchID, &run.Harness,
		&run.TriggerSource, &run.PRURL, &run.TargetSHA, &run.Status, &run.Verdict, &run.Body,
		&run.GithubReviewID, &run.CreatedAt, &run.DeliveredAt, &run.AutoInjectReview)
}

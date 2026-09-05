package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

const orchestrationColumns = `id, project_id, worker_id, kind, source_revision, state,
 attempt_count, enqueued_at, next_attempt_at, lease_token, lease_expires_at,
 destination_session_id, submitted_at, acknowledged_at, last_error`

func (s *Store) EnqueueOrchestrationEvent(ctx context.Context, e domain.OrchestrationEvent) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `INSERT INTO orchestration_events
 (id,project_id,worker_id,kind,source_revision,enqueued_at,next_attempt_at)
 VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,worker_id,kind,source_revision) DO NOTHING`,
		e.ID, e.ProjectID, e.WorkerID, e.Kind, e.SourceRevision, e.EnqueuedAt, e.NextAttemptAt)
	if err != nil {
		return false, fmt.Errorf("enqueue orchestration event: %w", err)
	}
	rows, err := result.RowsAffected()
	return rows == 1, err
}

func (s *Store) ReclaimOrchestrationEventLeases(ctx context.Context, now time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET state='pending',
 lease_token=NULL,lease_expires_at=NULL,destination_session_id=NULL,next_attempt_at=?
 WHERE state IN ('leased','submitted') AND lease_expires_at<=?`, now, now)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) ListDueOrchestrationEvents(ctx context.Context, project domain.ProjectID, now time.Time, limit int) ([]domain.OrchestrationEvent, error) {
	rows, err := s.readDB.QueryContext(ctx, `SELECT `+orchestrationColumns+` FROM orchestration_events
 WHERE project_id=? AND state='pending' AND next_attempt_at<=? ORDER BY enqueued_at,id LIMIT ?`, project, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOrchestrationEvents(rows)
}

func (s *Store) LeaseOrchestrationEvents(ctx context.Context, ids []string, token string, destination domain.SessionID, expires time.Time) error {
	return s.updateOrchestrationBatch(ctx, "lease orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state='leased',lease_token=?,lease_expires_at=?,destination_session_id=? WHERE id=? AND state='pending'`, token, expires, destination, id)
	})
}

func (s *Store) MarkOrchestrationEventsSubmitted(ctx context.Context, ids []string, token string, at time.Time) error {
	return s.updateOrchestrationBatch(ctx, "submit orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state='submitted',submitted_at=? WHERE id=? AND state='leased' AND lease_token=?`, at, id, token)
	})
}

func (s *Store) AcknowledgeOrchestrationEvents(ctx context.Context, ids []string, token string, at time.Time) error {
	return s.updateOrchestrationBatch(ctx, "acknowledge orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state='acknowledged',acknowledged_at=?,lease_token=NULL,lease_expires_at=NULL,last_error='' WHERE id=? AND state IN ('leased','submitted') AND lease_token=?`, at, id, token)
	})
}

func (s *Store) RetryOrchestrationEvents(ctx context.Context, events []domain.OrchestrationEvent, token, message string, now time.Time) error {
	if len(message) > 512 {
		message = message[:512]
	}
	byID := map[string]domain.OrchestrationEvent{}
	ids := make([]string, len(events))
	for i, e := range events {
		ids[i] = e.ID
		byID[e.ID] = e
	}
	return s.updateOrchestrationBatch(ctx, "retry orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		e := byID[id]
		attempt := e.AttemptCount + 1
		state := domain.OrchestrationPending
		if attempt >= 8 || now.Sub(e.EnqueuedAt) >= 15*time.Minute {
			state = domain.OrchestrationDeadLetter
		}
		backoff := time.Second << min(attempt-1, 5)
		if backoff > time.Minute {
			backoff = time.Minute
		}
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state=?,attempt_count=attempt_count+1,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=? WHERE id=? AND state IN ('leased','submitted') AND lease_token=? AND attempt_count<8`, state, now.Add(backoff), message, id, token)
	})
}

func (s *Store) updateOrchestrationBatch(ctx context.Context, what string, ids []string, update func(gen.DBTX, string) (sql.Result, error)) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.inTxDB(ctx, what, func(_ *gen.Queries, db gen.DBTX) error {
		for _, id := range ids {
			result, err := update(db, id)
			if err != nil {
				return err
			}
			rows, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if rows != 1 {
				return fmt.Errorf("event %s failed state fence", id)
			}
		}
		return nil
	})
}

type rowScanner interface{ Scan(...any) error }

func scanOrchestrationEvent(row rowScanner) (domain.OrchestrationEvent, error) {
	var e domain.OrchestrationEvent
	var project, worker, kind, state string
	var lease, destination, lastError sql.NullString
	var leaseExpiry, submitted, ack sql.NullTime
	err := row.Scan(&e.ID, &project, &worker, &kind, &e.SourceRevision, &state, &e.AttemptCount, &e.EnqueuedAt, &e.NextAttemptAt, &lease, &leaseExpiry, &destination, &submitted, &ack, &lastError)
	e.ProjectID = domain.ProjectID(project)
	e.WorkerID = domain.SessionID(worker)
	e.Kind = domain.OrchestrationEventKind(kind)
	e.State = domain.OrchestrationDeliveryState(state)
	e.LeaseToken = lease.String
	e.LeaseExpiresAt = leaseExpiry.Time
	e.DestinationSessionID = domain.SessionID(destination.String)
	e.SubmittedAt = submitted.Time
	e.AcknowledgedAt = ack.Time
	e.LastError = strings.TrimSpace(lastError.String)
	return e, err
}
func scanOrchestrationEvents(rows *sql.Rows) ([]domain.OrchestrationEvent, error) {
	var out []domain.OrchestrationEvent
	for rows.Next() {
		e, err := scanOrchestrationEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

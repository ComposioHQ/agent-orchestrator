package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

const orchestrationColumns = `id, project_id, worker_id, kind, source_revision, state,
 attempt_count, enqueued_at, next_attempt_at, lease_token, lease_expires_at,
 destination_session_id, submitted_at, acknowledged_at, attention_required_at, last_error`

// ReconcileTerminatedOrchestrationEvents deterministically closes the crash
// window between any terminal session mutation and its normalized event.
func (s *Store) ReconcileTerminatedOrchestrationEvents(ctx context.Context, now time.Time) (int, error) {
	sessions, err := s.ListAllSessions(ctx)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, rec := range sessions {
		if rec.Kind != domain.KindWorker || !rec.IsTerminated {
			continue
		}
		source := strings.TrimSpace(rec.Metadata.RuntimeLaunchID)
		if source == "" {
			source = strings.TrimSpace(rec.Metadata.ControllerGeneration)
		}
		if source == "" {
			source = rec.UpdatedAt.UTC().Format(time.RFC3339Nano)
		}
		inserted, err := s.RecordOrchestrationSourceState(ctx, rec.ProjectID, rec.ID, domain.OrchestrationWorkerTerminated, source, true, now)
		if err != nil {
			return created, err
		}
		if inserted {
			created++
		}
	}
	return created, nil
}

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

func (s *Store) RecordOrchestrationSourceState(ctx context.Context, project domain.ProjectID, worker domain.SessionID, kind domain.OrchestrationEventKind, sourceID string, active bool, now time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	created := false
	err := s.inTxDB(ctx, "record orchestration source state", func(_ *gen.Queries, db gen.DBTX) error {
		var previous int
		var generation int
		err := db.QueryRowContext(ctx, `SELECT active,generation FROM orchestration_source_states WHERE project_id=? AND worker_id=? AND kind=? AND source_id=?`, project, worker, kind, sourceID).Scan(&previous, &generation)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if err == sql.ErrNoRows {
			if active {
				generation = 1
				created = true
			}
			_, err = db.ExecContext(ctx, `INSERT INTO orchestration_source_states(project_id,worker_id,kind,source_id,active,generation,updated_at)VALUES(?,?,?,?,?,?,?)`, project, worker, kind, sourceID, active, generation, now)
			if err != nil {
				return err
			}
		} else {
			if (previous != 0) == active {
				return nil
			}
			if active {
				generation++
				created = true
			}
			_, err = db.ExecContext(ctx, `UPDATE orchestration_source_states SET active=?,generation=?,updated_at=? WHERE project_id=? AND worker_id=? AND kind=? AND source_id=?`, active, generation, now, project, worker, kind, sourceID)
			if err != nil {
				return err
			}
		}
		if !created {
			return nil
		}
		sourceHash := sha256.Sum256([]byte(sourceID))
		revision := hex.EncodeToString(sourceHash[:8]) + ":" + strconv.Itoa(generation)
		sum := sha256.Sum256([]byte(string(project) + "\x00" + string(worker) + "\x00" + string(kind) + "\x00" + sourceID + "\x00" + revision))
		id := "oe:" + hex.EncodeToString(sum[:16])
		_, err = db.ExecContext(ctx, `INSERT INTO orchestration_events(id,project_id,worker_id,kind,source_revision,enqueued_at,next_attempt_at)VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,worker_id,kind,source_revision) DO NOTHING`, id, project, worker, kind, revision, now, now)
		return err
	})
	return created, err
}

func (s *Store) ReclaimOrchestrationEventLeases(ctx context.Context, now time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET
	 state=CASE WHEN attempt_count+1>=2 OR enqueued_at<=? THEN 'dead_letter' ELSE 'pending' END,
	 attempt_count=attempt_count+1,lease_token=NULL,lease_expires_at=NULL,
	 attention_required_at=CASE WHEN attempt_count+1>=2 OR enqueued_at<=? THEN COALESCE(attention_required_at,?) ELSE attention_required_at END,
	 destination_session_id=NULL,next_attempt_at=?
	 WHERE state IN ('leased','submitted') AND lease_expires_at<=?`, now.Add(-15*time.Minute), now.Add(-15*time.Minute), now, now, now)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) MarkProjectNoDestinationAttention(ctx context.Context, project domain.ProjectID, now time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET attention_required_at=? WHERE project_id=? AND state='pending' AND attention_required_at IS NULL AND enqueued_at<=?`, now, project, now.Add(-15*time.Minute))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) MarkOrchestrationRetentionOverflow(ctx context.Context, now time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET state='dead_letter',attention_required_at=COALESCE(attention_required_at,?),last_error='retention limit exceeded' WHERE state='pending' AND (enqueued_at<=? OR id IN (SELECT id FROM orchestration_events AS overflow WHERE overflow.project_id=orchestration_events.project_id AND overflow.state='pending' ORDER BY overflow.enqueued_at DESC,overflow.id DESC LIMIT -1 OFFSET 10000))`, now, now.Add(-30*24*time.Hour))
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

func (s *Store) ListOrchestrationEvents(ctx context.Context, project domain.ProjectID, limit int) ([]domain.OrchestrationEvent, error) {
	rows, err := s.readDB.QueryContext(ctx, `SELECT `+orchestrationColumns+` FROM orchestration_events WHERE project_id=? ORDER BY enqueued_at DESC,id DESC LIMIT ?`, project, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOrchestrationEvents(rows)
}

// ListOrchestrationEventsRequiringAttention returns the durable source for
// reconstructing human-visible alerts after daemon or publisher failure.
func (s *Store) ListOrchestrationEventsRequiringAttention(ctx context.Context, project domain.ProjectID) ([]domain.OrchestrationEvent, error) {
	rows, err := s.readDB.QueryContext(ctx, `SELECT `+orchestrationColumns+` FROM orchestration_events
 WHERE project_id=? AND attention_required_at IS NOT NULL AND state IN ('pending','dead_letter') ORDER BY enqueued_at,id`, project)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOrchestrationEvents(rows)
}

func (s *Store) RetryDeadLetterOrchestrationEvent(ctx context.Context, project domain.ProjectID, id string, now time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET state='pending',attempt_count=0,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,destination_session_id=NULL,submitted_at=NULL,acknowledged_at=NULL,attention_required_at=NULL,last_error='' WHERE id=? AND project_id=? AND state='dead_letter'`, now, id, project)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	return rows == 1, err
}

func (s *Store) LeaseOrchestrationEvents(ctx context.Context, ids []string, token string, destination domain.SessionID, expires time.Time) error {
	return s.updateOrchestrationBatch(ctx, "lease orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state='leased',lease_token=?,lease_expires_at=?,destination_session_id=? WHERE id=? AND state='pending'`, token, expires, destination, id)
	})
}

func (s *Store) MarkOrchestrationEventsSubmitted(ctx context.Context, ids []string, token string, at time.Time) error {
	return s.updateOrchestrationBatch(ctx, "submit orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state=CASE WHEN state='leased' THEN 'submitted' ELSE state END,submitted_at=COALESCE(submitted_at,?) WHERE id=? AND state IN ('leased','acknowledged') AND lease_token=?`, at, id, token)
	})
}

func (s *Store) AcknowledgeOrchestrationEvents(ctx context.Context, ids []string, token string, at time.Time) error {
	return s.updateOrchestrationBatch(ctx, "acknowledge orchestration events", ids, func(db gen.DBTX, id string) (sql.Result, error) {
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state='acknowledged',acknowledged_at=?,lease_expires_at=NULL,last_error='' WHERE id=? AND state IN ('leased','submitted') AND lease_token=?`, at, id, token)
	})
}

// AcknowledgeOrchestrationBatchAccepted closes a TUI batch only when the
// lifecycle hook reports admission of the exact AO batch id at its destination.
func (s *Store) AcknowledgeOrchestrationBatchAccepted(ctx context.Context, destination domain.SessionID, token string, at time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE orchestration_events SET state='acknowledged',acknowledged_at=?,lease_expires_at=NULL,last_error=''
 WHERE destination_session_id=? AND lease_token=? AND state IN ('leased','submitted')`, at, destination, token)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
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
		if backoff > 48*time.Second {
			backoff = 48 * time.Second
		}
		backoff += orchestrationJitter(id, backoff/4)
		var attention any
		if state == domain.OrchestrationDeadLetter {
			attention = now
		}
		return db.ExecContext(ctx, `UPDATE orchestration_events SET state=?,attempt_count=attempt_count+1,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,last_error=?,attention_required_at=COALESCE(attention_required_at,?) WHERE id=? AND state IN ('leased','submitted') AND lease_token=? AND attempt_count<8`, state, now.Add(backoff), message, attention, id, token)
	})
}

func orchestrationJitter(id string, ceiling time.Duration) time.Duration {
	if ceiling <= 0 {
		return 0
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(id))
	return time.Duration(h.Sum64() % uint64(ceiling))
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
	var leaseExpiry, submitted, ack, attention sql.NullTime
	err := row.Scan(&e.ID, &project, &worker, &kind, &e.SourceRevision, &state, &e.AttemptCount, &e.EnqueuedAt, &e.NextAttemptAt, &lease, &leaseExpiry, &destination, &submitted, &ack, &attention, &lastError)
	e.ProjectID = domain.ProjectID(project)
	e.WorkerID = domain.SessionID(worker)
	e.Kind = domain.OrchestrationEventKind(kind)
	e.State = domain.OrchestrationDeliveryState(state)
	e.LeaseToken = lease.String
	e.LeaseExpiresAt = leaseExpiry.Time
	e.DestinationSessionID = domain.SessionID(destination.String)
	e.SubmittedAt = submitted.Time
	e.AcknowledgedAt = ack.Time
	e.AttentionRequiredAt = attention.Time
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

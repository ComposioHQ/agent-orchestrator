package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const maxChangeEventBatch = 4096

type transactionChangeRecorder struct {
	tx    pgx.Tx
	orgID string
}

// NewChangeEventRecorder binds the product-store hook to an existing tenant
// transaction. Callers must not retain the recorder after that transaction
// commits or rolls back.
func NewChangeEventRecorder(tx pgx.Tx, orgID string) ports.ChangeEventRecorder {
	return &transactionChangeRecorder{tx: tx, orgID: strings.TrimSpace(orgID)}
}

func (r *transactionChangeRecorder) RecordChange(ctx context.Context, pending ports.PendingChangeEvent) error {
	if r == nil || r.tx == nil || r.orgID == "" {
		return errors.New("record change: tenant transaction is required")
	}
	if strings.TrimSpace(pending.ProjectID) == "" || strings.TrimSpace(string(pending.Type)) == "" {
		return errors.New("record change: project and event type are required")
	}
	payload := pending.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if !json.Valid(payload) {
		return errors.New("record change: payload is not valid JSON")
	}
	if _, err := r.tx.Exec(ctx,
		`INSERT INTO ao_change_heads (org_id, last_seq)
		 VALUES ($1, 0)
		 ON CONFLICT (org_id) DO NOTHING`,
		r.orgID,
	); err != nil {
		return fmt.Errorf("record change head: %w", normalizeError(err))
	}
	var seq int64
	if err := r.tx.QueryRow(ctx,
		`UPDATE ao_change_heads
		 SET last_seq = last_seq + 1, updated_at = now()
		 WHERE org_id = $1
		 RETURNING last_seq`,
		r.orgID,
	).Scan(&seq); err != nil {
		return fmt.Errorf("allocate change sequence: %w", normalizeError(err))
	}
	if _, err := r.tx.Exec(ctx,
		`INSERT INTO ao_change_log (
		     org_id, seq, project_id, session_id, event_type, payload
		 ) VALUES ($1, $2, $3, $4, $5, $6)`,
		r.orgID,
		seq,
		strings.TrimSpace(pending.ProjectID),
		strings.TrimSpace(pending.SessionID),
		pending.Type,
		[]byte(payload),
	); err != nil {
		return fmt.Errorf("insert change event: %w", normalizeError(err))
	}
	return nil
}

// EventsAfter implements ports.ChangeEventSource with an organization-local
// durable cursor. Two organizations may both have seq 1; ctx selects which log
// is visible.
func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]ports.ChangeEvent, error) {
	if after < 0 {
		return nil, errors.New("read change events: cursor must be non-negative")
	}
	if limit <= 0 || limit > maxChangeEventBatch {
		return nil, fmt.Errorf("read change events: limit must be between 1 and %d", maxChangeEventBatch)
	}
	tx, identity, err := s.beginChangeTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT seq, project_id, session_id, event_type, payload, created_at
		 FROM ao_change_log
		 WHERE org_id = $1 AND seq > $2
		 ORDER BY seq
		 LIMIT $3`,
		identity.OrgID,
		after,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("read change events after %d: %w", after, normalizeError(err))
	}
	events, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ports.ChangeEvent, error) {
		var event ports.ChangeEvent
		err := row.Scan(&event.Seq, &event.ProjectID, &event.SessionID, &event.Type, &event.Payload, &event.CreatedAt)
		return event, err
	})
	if err != nil {
		return nil, fmt.Errorf("scan change events: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit change event read: %w", err)
	}
	return events, nil
}

// LatestSeq returns the committed organization-local log head.
func (s *Store) LatestSeq(ctx context.Context) (int64, error) {
	tx, identity, err := s.beginChangeTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var seq int64
	if err := tx.QueryRow(ctx,
		`SELECT COALESCE((
		     SELECT last_seq FROM ao_change_heads WHERE org_id = $1
		 ), 0)`,
		identity.OrgID,
	).Scan(&seq); err != nil {
		return 0, fmt.Errorf("read latest change sequence: %w", normalizeError(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit latest change sequence read: %w", err)
	}
	return seq, nil
}

// LoadChangeCursor reads a durable background-consumer offset scoped to ctx.
func (s *Store) LoadChangeCursor(ctx context.Context, consumer string) (int64, error) {
	consumer, err := validateChangeConsumer(consumer)
	if err != nil {
		return 0, err
	}
	tx, identity, err := s.beginChangeTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var seq int64
	err = tx.QueryRow(ctx,
		`SELECT last_seq FROM ao_change_cursors
		 WHERE org_id = $1 AND consumer = $2`,
		identity.OrgID,
		consumer,
	).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		seq = 0
	} else if err != nil {
		return 0, fmt.Errorf("load change cursor: %w", normalizeError(err))
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit change cursor read: %w", err)
	}
	return seq, nil
}

// AdvanceChangeCursor monotonically checkpoints a committed sequence. Replays
// of the same or an older event are successful no-ops.
func (s *Store) AdvanceChangeCursor(ctx context.Context, consumer string, seq int64) error {
	consumer, err := validateChangeConsumer(consumer)
	if err != nil {
		return err
	}
	if seq < 0 {
		return errors.New("advance change cursor: sequence must be non-negative")
	}
	tx, identity, err := s.beginChangeTenantTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := tx.Exec(ctx,
		`INSERT INTO ao_change_cursors (org_id, consumer, last_seq)
		 SELECT $1, $2, $3
		 WHERE $3 <= COALESCE((
		     SELECT last_seq FROM ao_change_heads WHERE org_id = $1
		 ), 0)
		 ON CONFLICT (org_id, consumer) DO UPDATE
		 SET last_seq = GREATEST(ao_change_cursors.last_seq, EXCLUDED.last_seq),
		     updated_at = CASE
		         WHEN EXCLUDED.last_seq > ao_change_cursors.last_seq THEN now()
		         ELSE ao_change_cursors.updated_at
		     END`,
		identity.OrgID,
		consumer,
		seq,
	)
	if err != nil {
		return fmt.Errorf("advance change cursor: %w", normalizeError(err))
	}
	if result.RowsAffected() == 0 {
		return errors.New("advance change cursor: sequence is ahead of the committed log")
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit change cursor: %w", err)
	}
	return nil
}

func validateChangeConsumer(consumer string) (string, error) {
	consumer = strings.TrimSpace(consumer)
	if consumer == "" || len(consumer) > 255 {
		return "", errors.New("change cursor consumer must contain 1 to 255 bytes")
	}
	return consumer, nil
}

func (s *Store) beginChangeTenantTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, tenant.Identity, error) {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return nil, tenant.Identity{}, tenant.ErrNoTenant
	}
	tx, err := s.pool.BeginTx(ctx, options)
	if err != nil {
		return nil, tenant.Identity{}, fmt.Errorf("begin tenant change transaction: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true),
		        set_config('ao.org_id', $2, true)`,
		identity.UserID,
		identity.OrgID,
	); err != nil {
		_ = tx.Rollback(ctx)
		return nil, tenant.Identity{}, fmt.Errorf("scope tenant change transaction: %w", err)
	}
	return tx, identity, nil
}

var (
	_ ports.ChangeEventRecorder    = (*transactionChangeRecorder)(nil)
	_ ports.ChangeEventSource      = (*Store)(nil)
	_ ports.ChangeEventCursorStore = (*Store)(nil)
)

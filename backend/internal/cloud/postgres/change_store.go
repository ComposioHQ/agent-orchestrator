package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const maxChangeEventBatch = 4096

// EventsAfter implements cdc.Source with an organization-local
// durable cursor. Two organizations may both have seq 1; ctx selects which log
// is visible.
func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]ports.ChangeEvent, error) {
	if after < 0 {
		return nil, errors.New("read change events: cursor must be non-negative")
	}
	if limit <= 0 || limit > maxChangeEventBatch {
		return nil, fmt.Errorf("read change events: limit must be between 1 and %d", maxChangeEventBatch)
	}
	var events []ports.ChangeEvent
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
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
			return fmt.Errorf("read change events after %d: %w", after, normalizeError(err))
		}
		events, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (ports.ChangeEvent, error) {
			var event ports.ChangeEvent
			err := row.Scan(&event.Seq, &event.ProjectID, &event.SessionID, &event.Type, &event.Payload, &event.CreatedAt)
			return event, err
		})
		if err != nil {
			return fmt.Errorf("scan change events: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return events, nil
}

// LatestSeq returns the committed organization-local log head.
func (s *Store) LatestSeq(ctx context.Context) (int64, error) {
	var seq int64
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE((
			     SELECT last_seq FROM ao_change_heads WHERE org_id = $1
			 ), 0)`,
			identity.OrgID,
		).Scan(&seq); err != nil {
			return fmt.Errorf("read latest change sequence: %w", normalizeError(err))
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return seq, nil
}

// LoadChangeCursor reads a durable background-consumer offset scoped to ctx.
func (s *Store) LoadChangeCursor(ctx context.Context, consumer string) (int64, error) {
	consumer, err := validateChangeConsumer(consumer)
	if err != nil {
		return 0, err
	}
	var seq int64
	err = s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, identity tenant.Identity) error {
		err := tx.QueryRow(ctx,
			`SELECT last_seq FROM ao_change_cursors
			 WHERE org_id = $1 AND consumer = $2`,
			identity.OrgID,
			consumer,
		).Scan(&seq)
		if errors.Is(err, pgx.ErrNoRows) {
			seq = 0
			return nil
		}
		if err != nil {
			return fmt.Errorf("load change cursor: %w", normalizeError(err))
		}
		return nil
	})
	if err != nil {
		return 0, err
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
	return s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
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
		return nil
	})
}

func validateChangeConsumer(consumer string) (string, error) {
	consumer = strings.TrimSpace(consumer)
	if consumer == "" || len(consumer) > 255 {
		return "", errors.New("change cursor consumer must contain 1 to 255 bytes")
	}
	return consumer, nil
}

var (
	_ cdc.Source = (*Store)(nil)
)

package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// EventsAfter implements cdc.Source over the SQLite change_log table.
func (s *Store) EventsAfter(ctx context.Context, after int64, limit int) ([]cdc.Event, error) {
	rows, err := s.qr.ReadChangeLogAfter(ctx, gen.ReadChangeLogAfterParams{Seq: after, Limit: int64(limit)})
	if err != nil {
		return nil, fmt.Errorf("read change_log after %d: %w", after, err)
	}
	events := make([]cdc.Event, 0, len(rows))
	for _, r := range rows {
		events = append(events, changeLogEventFromGen(r))
	}
	return events, nil
}

// LatestSeq implements cdc.Source by returning the current change_log head.
func (s *Store) LatestSeq(ctx context.Context) (int64, error) {
	seq, err := s.qr.MaxChangeLogSeq(ctx)
	if err != nil {
		return 0, fmt.Errorf("max change_log seq: %w", err)
	}
	return seq, nil
}

// ChangeLogRetentionRows caps how many recent change_log events are retained.
// The log is an invalidation feed: clients that fall further behind than this
// refetch state on reconnect instead of replaying history (see httpd.events).
const ChangeLogRetentionRows = 100_000

const (
	// Keep each writer-lock hold small enough for interactive writes to run
	// between retention batches. A bloated log may need hundreds of batches;
	// one bulk DELETE would otherwise block ao send for the whole prune.
	changeLogPruneBatchRows = 1_000
	changeLogPruneYield     = time.Millisecond
	changeLogVacuumPages    = 4_096
)

// PruneChangeLog deletes acknowledged change_log rows beyond the newest keep
// events so the CDC log cannot grow unbounded (#3963). broadcastThrough is the
// live poller's watermark: rows newer than it have not reached connected
// subscribers and must not be removed. The delete runs by the seq PK directly
// rather than through sqlc because sqlc 1.31 mangles this nullable-table DELETE
// shape (see queries/changelog.sql). Deletes run in bounded batches and yield
// the writer lock between batches so interactive writes are not starved.
// Incremental vacuuming is page-bounded and the passive checkpoint never waits
// for readers, keeping post-prune maintenance bounded too.
func (s *Store) PruneChangeLog(ctx context.Context, keep, broadcastThrough int64) (int64, error) {
	if keep <= 0 {
		keep = ChangeLogRetentionRows
	}
	if broadcastThrough <= 0 {
		return 0, nil
	}
	// Select the (keep+1)th newest row rather than subtracting sequence numbers:
	// session deletion can leave gaps in the AUTOINCREMENT sequence.
	var pruneThrough int64
	if err := s.readDB.QueryRowContext(ctx, `
SELECT COALESCE((
    SELECT seq FROM change_log ORDER BY seq DESC LIMIT 1 OFFSET ?
), 0)`, keep).Scan(&pruneThrough); err != nil {
		return 0, fmt.Errorf("find change_log retention boundary: %w", err)
	}
	if pruneThrough <= 0 {
		return 0, nil
	}
	if broadcastThrough < pruneThrough {
		pruneThrough = broadcastThrough
	}

	var total int64
	for {
		if err := s.lockChangeLogPrune(ctx); err != nil {
			return total, err
		}
		res, err := s.writeDB.ExecContext(ctx, `
DELETE FROM change_log
WHERE seq IN (
    SELECT seq FROM change_log WHERE seq <= ? ORDER BY seq LIMIT ?
)`, pruneThrough, changeLogPruneBatchRows)
		s.writeMu.Unlock()
		if err != nil {
			return total, fmt.Errorf("prune change_log through %d: %w", pruneThrough, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			return total, fmt.Errorf("prune change_log through %d: rows affected: %w", pruneThrough, err)
		}
		total += n
		if n < changeLogPruneBatchRows {
			break
		}
		if err := waitChangeLogPruneYield(ctx); err != nil {
			return total, err
		}
	}
	if total == 0 {
		return 0, nil
	}

	if err := s.lockChangeLogPrune(ctx); err != nil {
		return total, err
	}
	_, vacuumErr := s.writeDB.ExecContext(ctx, fmt.Sprintf("PRAGMA incremental_vacuum(%d)", changeLogVacuumPages))
	var checkpointErr error
	if vacuumErr == nil {
		_, checkpointErr = s.writeDB.ExecContext(ctx, `PRAGMA wal_checkpoint(PASSIVE)`)
	}
	s.writeMu.Unlock()
	if vacuumErr != nil {
		return total, fmt.Errorf("incremental vacuum after change_log prune: %w", vacuumErr)
	}
	if checkpointErr != nil {
		return total, fmt.Errorf("checkpoint after change_log prune: %w", checkpointErr)
	}
	return total, nil
}

// lockChangeLogPrune uses the mutex's fair blocking acquisition so continuous
// user writes cannot starve retention. Once acquired, an expired pass releases
// the writer immediately without starting another batch.
func (s *Store) lockChangeLogPrune(ctx context.Context) error {
	s.writeMu.Lock()
	if err := ctx.Err(); err != nil {
		s.writeMu.Unlock()
		return fmt.Errorf("acquire change_log prune writer: %w", err)
	}
	return nil
}

func waitChangeLogPruneYield(ctx context.Context) error {
	timer := time.NewTimer(changeLogPruneYield)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return fmt.Errorf("yield change_log prune writer: %w", ctx.Err())
	case <-timer.C:
		return nil
	}
}

func changeLogEventFromGen(r gen.ChangeLog) cdc.Event {
	e := cdc.Event{
		Seq:       r.Seq,
		ProjectID: string(r.ProjectID),
		Type:      r.EventType,
		Payload:   json.RawMessage(r.Payload),
		CreatedAt: r.CreatedAt,
	}
	if r.SessionID != nil {
		e.SessionID = string(*r.SessionID)
	}
	return e
}

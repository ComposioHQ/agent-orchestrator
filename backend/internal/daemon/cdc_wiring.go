package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	sqlitestore "github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// retentionInterval is how often the daemon prunes change_log back to the
// retention cap. An initial prune runs at startup so a log bloated by a
// previous release shrinks without waiting a full interval.
const retentionInterval = 6 * time.Hour

// pruneTimeout bounds one retention pass; deleting up to the growth accumulated
// over an interval is far smaller than this on any realistic machine.
const pruneTimeout = 5 * time.Minute

type cdcRetentionConfig struct {
	interval time.Duration
	timeout  time.Duration
	rows     int64
}

// cdcPipeline owns the running CDC poller and live-event broadcaster, plus the
// change_log retention loop. The DB triggers write change_log; the poller tails
// it and fans each new event out to live transports such as terminal
// session-state subscriptions; retention keeps the append-only log bounded.
// Durable catch-up is a client concern; the poller only pushes live events and
// re-seeks to head on restart.
type cdcPipeline struct {
	Broadcaster   *cdc.Broadcaster
	done          <-chan struct{}
	retentionDone <-chan struct{}
}

// startCDC seeks the poller to the current head, starts its loop, and starts
// change_log retention. Both stop when ctx is cancelled; Stop waits for them.
func startCDC(ctx context.Context, store *sqlite.Store, logger *slog.Logger) (*cdcPipeline, error) {
	return startCDCWithRetention(ctx, store, logger, cdcRetentionConfig{
		interval: retentionInterval,
		timeout:  pruneTimeout,
		rows:     sqlitestore.ChangeLogRetentionRows,
	})
}

func startCDCWithRetention(
	ctx context.Context,
	store *sqlite.Store,
	logger *slog.Logger,
	retention cdcRetentionConfig,
) (*cdcPipeline, error) {
	if retention.interval <= 0 {
		retention.interval = retentionInterval
	}
	if retention.timeout <= 0 {
		retention.timeout = pruneTimeout
	}
	if retention.rows <= 0 {
		retention.rows = sqlitestore.ChangeLogRetentionRows
	}
	bcast := cdc.NewBroadcaster()
	poller := cdc.NewPoller(store, bcast, cdc.PollerConfig{Logger: logger})
	if err := poller.SeekToHead(ctx); err != nil {
		return nil, err
	}
	return &cdcPipeline{
		Broadcaster:   bcast,
		done:          poller.Start(ctx),
		retentionDone: startChangeLogRetention(ctx, store, poller, logger, retention),
	}, nil
}

// Stop waits for the poller and retention goroutines to exit, bounded by ctx.
// The caller must first cancel the context passed to startCDC.
func (p *cdcPipeline) Stop(ctx context.Context) error {
	if err := waitCDCWorker(ctx, p.done, "poller"); err != nil {
		return err
	}
	return waitCDCWorker(ctx, p.retentionDone, "retention")
}

func stopCDCPipeline(ctx context.Context, p *cdcPipeline, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return p.Stop(ctx)
}

func waitCDCWorker(ctx context.Context, done <-chan struct{}, name string) error {
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("wait for CDC %s: %w", name, ctx.Err())
	}
}

// startChangeLogRetention prunes change_log once at startup and then every
// retentionInterval until ctx is cancelled.
func startChangeLogRetention(
	ctx context.Context,
	store *sqlite.Store,
	poller *cdc.Poller,
	logger *slog.Logger,
	cfg cdcRetentionConfig,
) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		pruneChangeLogOnce(ctx, store, poller.LastSeq(), logger, cfg)
		t := time.NewTicker(cfg.interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				pruneChangeLogOnce(ctx, store, poller.LastSeq(), logger, cfg)
			}
		}
	}()
	return done
}

func pruneChangeLogOnce(
	ctx context.Context,
	store *sqlite.Store,
	broadcastThrough int64,
	logger *slog.Logger,
	cfg cdcRetentionConfig,
) {
	ctx, cancel := context.WithTimeout(ctx, cfg.timeout)
	defer cancel()
	n, err := store.PruneChangeLog(ctx, cfg.rows, broadcastThrough)
	if err != nil {
		logger.Warn("change_log retention prune failed", "err", err)
		return
	}
	if n > 0 {
		logger.Info("change_log retention pruned", "rows", n)
	}
}

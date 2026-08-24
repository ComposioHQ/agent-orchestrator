package cdc

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"
)

// DefaultPollInterval is how often the poller checks change_log for new rows.
// Polling (rather than fs-notify or a DB hook) keeps it dependency-free; at this
// cadence live updates stay well under a human-perceptible delay.
const DefaultPollInterval = 100 * time.Millisecond

// DefaultBatch bounds how many events one poll drains.
const DefaultBatch = 512

// Source is the poller's view of the durable log: read events after a seq, and
// the current head seq. The storage layer implements it (the change_log table).
type Source interface {
	EventsAfter(ctx context.Context, after int64, limit int) ([]Event, error)
	LatestSeq(ctx context.Context) (int64, error)
}

// Poller tails change_log and fans each new event out through the Broadcaster,
// in seq order. It holds only an in-memory cursor (lastSeq): it is the LIVE push
// path, while durable catch-up is the client's job (read change_log from its own
// offset). A restart re-seeks to head, so the poller never re-broadcasts history
// to a freshly-started broadcaster.
type Poller struct {
	src      Source
	bcast    *Broadcaster
	interval time.Duration
	batch    int
	logger   *slog.Logger
	lastSeq  atomic.Int64
}

// PollerConfig holds optional knobs; zero values fall back to defaults. StartSeq
// is the cursor to begin from; production wiring leaves it 0 and calls
// SeekToHead, tests set it to read from the beginning.
type PollerConfig struct {
	Interval time.Duration
	Batch    int
	Logger   *slog.Logger
	StartSeq int64
}

// NewPoller constructs a Poller over src, fanning out through bcast.
func NewPoller(src Source, bcast *Broadcaster, cfg PollerConfig) *Poller {
	p := &Poller{
		src:      src,
		bcast:    bcast,
		interval: cfg.Interval,
		batch:    cfg.Batch,
		logger:   cfg.Logger,
	}
	p.lastSeq.Store(cfg.StartSeq)
	if p.interval <= 0 {
		p.interval = DefaultPollInterval
	}
	if p.batch <= 0 {
		p.batch = DefaultBatch
	}
	if p.logger == nil {
		p.logger = slog.Default()
	}
	return p
}

// SeekToHead moves the cursor to the current head, so the poller only broadcasts
// events created from now on (clients catch up on older events via the store).
func (p *Poller) SeekToHead(ctx context.Context) error {
	seq, err := p.src.LatestSeq(ctx)
	if err != nil {
		return fmt.Errorf("cdc poller seek: %w", err)
	}
	p.lastSeq.Store(seq)
	return nil
}

// Start runs the poll loop until ctx is cancelled; the returned channel closes
// when the loop has exited.
func (p *Poller) Start(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(p.interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if err := p.Poll(ctx); err != nil {
					p.logger.Error("cdc poller: poll failed", "err", err)
				}
			}
		}
	}()
	return done
}

// Poll drains one batch of new events and broadcasts them in seq order,
// advancing the cursor. Exported so tests (and a daemon) can drive a cycle
// synchronously.
func (p *Poller) Poll(ctx context.Context) error {
	lastSeq := p.lastSeq.Load()
	evs, err := p.src.EventsAfter(ctx, lastSeq, p.batch)
	if err != nil {
		return fmt.Errorf("cdc poller: read after %d: %w", lastSeq, err)
	}
	for _, e := range evs {
		if e.Seq <= lastSeq {
			continue // idempotent guard
		}
		p.bcast.Publish(e)
		lastSeq = e.Seq
		p.lastSeq.Store(lastSeq)
	}
	return nil
}

// LastSeq returns the poller's current cursor (the highest seq broadcast).
func (p *Poller) LastSeq() int64 { return p.lastSeq.Load() }

package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestCDCStartupAndPeriodicRetentionPreserveLiveDelivery(t *testing.T) {
	store, err := sqlitetest.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	seedCDCProject(t, store, "retention")
	seedCDCSessions(t, store, "retention", 12)

	ctx, cancel := context.WithCancel(context.Background())
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	pipe, err := startCDCWithRetention(ctx, store, logger, cdcRetentionConfig{
		interval: 10 * time.Millisecond,
		timeout:  time.Second,
		rows:     5,
	})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		stopCtx, stopCancel := context.WithTimeout(context.Background(), time.Second)
		defer stopCancel()
		_ = pipe.Stop(stopCtx)
	})

	waitForChangeLogCount(t, store, 5)
	head, err := store.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq after startup prune: %v", err)
	}

	var mu sync.Mutex
	var delivered []int64
	unsubscribe := pipe.Broadcaster.Subscribe(func(event cdc.Event) {
		mu.Lock()
		delivered = append(delivered, event.Seq)
		mu.Unlock()
	})
	t.Cleanup(unsubscribe)

	seedCDCSessions(t, store, "retention", 7)
	waitFor(t, "seven live CDC events", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(delivered) == 7
	})
	waitForChangeLogCount(t, store, 5)

	mu.Lock()
	defer mu.Unlock()
	for i, seq := range delivered {
		if want := head + int64(i) + 1; seq != want {
			t.Fatalf("delivered[%d] = %d, want %d", i, seq, want)
		}
	}
}

func TestCDCPipelineStopHonorsContext(t *testing.T) {
	p := &cdcPipeline{
		done:          make(chan struct{}),
		retentionDone: make(chan struct{}),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	err := p.Stop(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop error = %v, want context deadline exceeded", err)
	}
}

func seedCDCProject(t *testing.T, store *sqlite.Store, projectID string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	if err := store.UpsertProject(context.Background(), domain.ProjectRecord{
		ID:           projectID,
		Path:         "/tmp/" + projectID,
		RegisteredAt: now,
	}); err != nil {
		t.Fatalf("seed project: %v", err)
	}
}

func seedCDCSessions(t *testing.T, store *sqlite.Store, projectID string, count int) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	for i := 0; i < count; i++ {
		if _, err := store.CreateSession(context.Background(), domain.SessionRecord{
			ProjectID: domain.ProjectID(projectID),
			Kind:      domain.KindWorker,
			Activity: domain.Activity{
				State:          domain.ActivityActive,
				LastActivityAt: now,
			},
			CreatedAt: now,
			UpdatedAt: now,
		}); err != nil {
			t.Fatalf("seed session %d: %v", i, err)
		}
	}
}

func waitForChangeLogCount(t *testing.T, store *sqlite.Store, want int) {
	t.Helper()
	waitFor(t, "change_log retention", func() bool {
		events, err := store.EventsAfter(context.Background(), 0, 1000)
		return err == nil && len(events) == want
	})
}

func waitFor(t *testing.T, what string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

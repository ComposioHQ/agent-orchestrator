package store_test

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// seedChangeLogRows creates n sessions so their CDC triggers append n
// change_log rows with contiguous seqs, then reports the log head.
func seedChangeLogRows(t *testing.T, s *sqlite.Store, project string, n int) int64 {
	t.Helper()
	seedProject(t, s, project)
	ctx := context.Background()
	for i := 0; i < n; i++ {
		if _, err := s.CreateSession(ctx, sampleRecord(project)); err != nil {
			t.Fatalf("seed session %d: %v", i, err)
		}
	}
	head, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}
	return head
}

func TestPruneChangeLogKeepsNewestRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head := seedChangeLogRows(t, s, "mer", 150)

	n, err := s.PruneChangeLog(ctx, 50, head)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != head-50 {
		t.Fatalf("pruned = %d, want %d", n, head-50)
	}

	events, err := s.EventsAfter(ctx, 0, 1000)
	if err != nil {
		t.Fatalf("events after prune: %v", err)
	}
	if len(events) != 50 {
		t.Fatalf("remaining events = %d, want 50", len(events))
	}
	if events[0].Seq != head-49 {
		t.Fatalf("oldest retained seq = %d, want %d", events[0].Seq, head-49)
	}
}

func TestPruneChangeLogNoopBelowCap(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedChangeLogRows(t, s, "mer", 10)

	head, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}
	n, err := s.PruneChangeLog(ctx, 100, head)
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 0 {
		t.Fatalf("pruned = %d, want 0 (log below cap must be untouched)", n)
	}
}

func TestPruneChangeLogIdempotent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedChangeLogRows(t, s, "mer", 120)

	head, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}
	if _, err := s.PruneChangeLog(ctx, 50, head); err != nil {
		t.Fatalf("first prune: %v", err)
	}
	n, err := s.PruneChangeLog(ctx, 50, head)
	if err != nil {
		t.Fatalf("second prune: %v", err)
	}
	if n != 0 {
		t.Fatalf("second prune removed %d rows, want 0", n)
	}
}

func TestPruneChangeLogCountsRowsAcrossSequenceGaps(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "mer")
	now := time.Now().UTC().Truncate(time.Second)
	ids := make([]domain.SessionID, 150)
	for i := range ids {
		created, err := s.CreateSession(ctx, domain.SessionRecord{
			ProjectID: "mer",
			Kind:      domain.KindWorker,
			Harness:   domain.HarnessClaudeCode,
			Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			t.Fatalf("seed session %d: %v", i, err)
		}
		ids[i] = created.ID
	}
	// Seed-session deletion removes its CDC row. Delete most recent-ish rows
	// while leaving the head intact so a maxSeq-keep boundary would retain only
	// ten events instead of the requested fifty.
	for _, id := range ids[100:140] {
		deleted, err := s.DeleteSession(ctx, id)
		if err != nil || !deleted {
			t.Fatalf("delete seed session %s: deleted=%v err=%v", id, deleted, err)
		}
	}
	before, err := s.EventsAfter(ctx, 0, 1000)
	if err != nil {
		t.Fatalf("events before gap-aware prune: %v", err)
	}
	head, err := s.LatestSeq(ctx)
	if err != nil {
		t.Fatalf("latest seq: %v", err)
	}

	n, err := s.PruneChangeLog(ctx, 50, head)
	if err != nil {
		t.Fatalf("prune across sequence gaps: %v", err)
	}
	if got, want := n, int64(len(before)-50); got != want {
		t.Fatalf("pruned = %d, want %d", got, want)
	}
	after, err := s.EventsAfter(ctx, 0, 1000)
	if err != nil {
		t.Fatalf("events after gap-aware prune: %v", err)
	}
	if got, want := len(after), 50; got != want {
		t.Fatalf("remaining events = %d, want %d", got, want)
	}
	wantOldest := before[len(before)-50].Seq
	if got := after[0].Seq; got != wantOldest {
		t.Fatalf("oldest retained seq = %d, want %d", got, wantOldest)
	}
}

func TestPruneChangeLogPreservesRowsBeyondPollerWatermark(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	head := seedChangeLogRows(t, s, "mer", 150)
	watermark := head - 75

	n, err := s.PruneChangeLog(ctx, 50, watermark)
	if err != nil {
		t.Fatalf("prune at lagging watermark: %v", err)
	}
	if n != watermark {
		t.Fatalf("pruned = %d, want %d acknowledged rows", n, watermark)
	}
	events, err := s.EventsAfter(ctx, 0, 1000)
	if err != nil {
		t.Fatalf("events after watermark-limited prune: %v", err)
	}
	if got, want := events[0].Seq, watermark+1; got != want {
		t.Fatalf("oldest retained seq = %d, want unread seq %d", got, want)
	}
	if got, want := len(events), int(head-watermark); got != want {
		t.Fatalf("remaining events = %d, want %d", got, want)
	}
}

func TestPruneChangeLogYieldsToConcurrentWrites(t *testing.T) {
	s := newTestStore(t)
	head := seedChangeLogRows(t, s, "concurrent-prune", 5_000)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	start := make(chan struct{})
	stop := make(chan struct{})
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	var completedMu sync.Mutex
	var completed []time.Time
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for {
				select {
				case <-stop:
					return
				default:
				}
				if _, err := s.CreateSession(ctx, sampleRecord("concurrent-prune")); err != nil {
					errs <- err
					return
				}
				completedMu.Lock()
				completed = append(completed, time.Now())
				completedMu.Unlock()
				time.Sleep(time.Millisecond)
			}
		}()
	}
	close(start)
	// Let every writer prove it can reach the store before retention begins.
	waitUntil := time.Now().Add(2 * time.Second)
	for {
		completedMu.Lock()
		ready := len(completed) >= 8
		completedMu.Unlock()
		if ready {
			break
		}
		if time.Now().After(waitUntil) {
			close(stop)
			wg.Wait()
			t.Fatal("concurrent writers did not start")
		}
		time.Sleep(time.Millisecond)
	}

	pruneStarted := time.Now()
	if _, err := s.PruneChangeLog(ctx, 50, head); err != nil {
		close(stop)
		wg.Wait()
		t.Fatalf("prune under writes: %v", err)
	}
	pruneFinished := time.Now()
	close(stop)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent write failed: %v", err)
	}

	completedMu.Lock()
	defer completedMu.Unlock()
	var duringPrune int
	for _, at := range completed {
		if at.After(pruneStarted) && at.Before(pruneFinished) {
			duringPrune++
		}
	}
	if duringPrune < 2 {
		t.Fatalf("writes completed during prune = %d, want at least 2 (retention starved interactive writes)", duringPrune)
	}
}

func TestPruneChangeLogReturnsFreedPagesToOS(t *testing.T) {
	dir := t.TempDir()
	store, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	seedChangeLogRows(t, store, "vacuum", 2_000)
	if err := store.Close(); err != nil {
		t.Fatalf("close seeded store: %v", err)
	}
	dbPath := filepath.Join(dir, "ao.db")
	before, err := os.Stat(dbPath)
	if err != nil {
		t.Fatalf("stat database before prune: %v", err)
	}

	store, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	head, err := store.LatestSeq(context.Background())
	if err != nil {
		_ = store.Close()
		t.Fatalf("latest seq: %v", err)
	}
	if _, err := store.PruneChangeLog(context.Background(), 50, head); err != nil {
		_ = store.Close()
		t.Fatalf("prune: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close pruned store: %v", err)
	}
	after, err := os.Stat(dbPath)
	if err != nil {
		t.Fatalf("stat database after prune: %v", err)
	}
	if after.Size() >= before.Size() {
		t.Fatalf("database size after prune = %d, want less than %d", after.Size(), before.Size())
	}
}

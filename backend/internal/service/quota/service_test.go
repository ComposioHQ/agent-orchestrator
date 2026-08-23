package quota

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type memoryQuotaStore struct {
	mu           sync.Mutex
	snapshot     domain.QuotaSnapshot
	has          bool
	failureCalls int
}

type testRefresher struct {
	calls      atomic.Int64
	snapshot   domain.QuotaSnapshot
	refreshErr error
	absent     bool
}

func (r *testRefresher) RefreshQuota(context.Context, domain.QuotaProviderID, domain.QuotaAccountID) (domain.QuotaSnapshot, error) {
	r.calls.Add(1)
	return r.snapshot, r.refreshErr
}

func (r *testRefresher) QuotaAccountPresent(context.Context, domain.QuotaProviderID, domain.QuotaAccountID) (bool, error) {
	return !r.absent, nil
}

func (s *memoryQuotaStore) PersistQuotaObservation(_ context.Context, snapshot domain.QuotaSnapshot, _ []domain.QuotaAlert) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot, s.has = snapshot, true
	return nil
}

func (*memoryQuotaStore) ListQuotaAlerts(context.Context, time.Time, int64) ([]domain.QuotaAlert, error) {
	return nil, nil
}

func (s *memoryQuotaStore) ListQuotaSnapshots(context.Context) ([]domain.QuotaSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.has {
		return nil, nil
	}
	return []domain.QuotaSnapshot{s.snapshot}, nil
}

func (s *memoryQuotaStore) GetQuotaSnapshot(context.Context, domain.QuotaProviderID, domain.QuotaAccountID) (domain.QuotaSnapshot, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshot, s.has, nil
}

func (*memoryQuotaStore) ListQuotaHistory(context.Context, domain.QuotaProviderID, domain.QuotaAccountID, time.Time, int64) ([]domain.QuotaHistoryPoint, error) {
	return nil, nil
}

func (*memoryQuotaStore) CompactQuotaHistory(context.Context, time.Time) (int64, error) {
	return 0, nil
}

func (s *memoryQuotaStore) RecordQuotaRefreshFailure(_ context.Context, _ domain.QuotaProviderID, _ domain.QuotaAccountID, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failureCalls++
	if !s.has {
		return fmt.Errorf("quota account does not exist")
	}
	s.snapshot.RefreshError = message
	return nil
}

func TestCollectRateLimitsCoalescesAccountReads(t *testing.T) {
	service := New(&memoryQuotaStore{})
	var calls atomic.Int64
	release := make(chan struct{})
	reader := func(context.Context) (ports.ChatRateLimits, error) {
		calls.Add(1)
		<-release
		now := time.Now().UTC()
		used := 42.0
		return ports.ChatRateLimits{Quota: &domain.QuotaSnapshot{
			Provider: "codex", AccountID: "default", Completeness: domain.QuotaComplete, ObservedAt: now,
			Limits: []domain.QuotaLimit{{ID: "primary", UsedPercent: &used}},
		}}, nil
	}

	const callers = 12
	var wg sync.WaitGroup
	wg.Add(callers)
	start := make(chan struct{})
	errs := make(chan error, callers)
	for range callers {
		go func() {
			defer wg.Done()
			<-start
			_, err := service.CollectRateLimits(context.Background(), "codex", "default", reader)
			errs <- err
		}()
	}
	close(start)
	for calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("provider reads = %d, want 1", calls.Load())
	}

	if _, err := service.CollectRateLimits(context.Background(), "codex", "default", reader); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("fresh cached provider reads = %d, want 1", calls.Load())
	}
}

func TestRegisteredRefresherWorksWithoutExistingSessionOrSnapshot(t *testing.T) {
	store := &memoryQuotaStore{}
	service := New(store)
	reader := &testRefresher{snapshot: domain.QuotaSnapshot{
		Provider: "claude", AccountID: "default", Completeness: domain.QuotaComplete, ObservedAt: time.Now().UTC(),
	}}
	service.RegisterRefresher("claude", "default", reader)

	snapshots, err := service.RefreshAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reader.calls.Load() != 1 || len(snapshots) != 1 || snapshots[0].Provider != "claude" {
		t.Fatalf("calls=%d snapshots=%#v", reader.calls.Load(), snapshots)
	}
}

func TestRegisteredRefreshSkipsFreshObservation(t *testing.T) {
	store := &memoryQuotaStore{has: true, snapshot: domain.QuotaSnapshot{
		Provider: "claude", AccountID: "default", Completeness: domain.QuotaComplete, ObservedAt: time.Now().UTC(),
	}}
	service := New(store)
	reader := &testRefresher{snapshot: store.snapshot}
	service.RegisterRefresher("claude", "default", reader)

	service.RefreshRegisteredIfStale(context.Background())
	if reader.calls.Load() != 0 {
		t.Fatalf("fresh provider reads = %d, want 0", reader.calls.Load())
	}
}

func TestRegisteredRefreshPersistsFirstFailureForInstalledProvider(t *testing.T) {
	store := &memoryQuotaStore{}
	service := New(store)
	refreshErr := errors.New("provider authentication failed")
	reader := &testRefresher{refreshErr: refreshErr}
	service.RegisterRefresher("claude", "default", reader)

	snapshots, err := service.RefreshAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reader.calls.Load() != 1 || len(snapshots) != 1 {
		t.Fatalf("calls=%d snapshots=%#v", reader.calls.Load(), snapshots)
	}
	got := snapshots[0]
	if got.Provider != "claude" || got.AccountID != "default" || got.RefreshError != refreshErr.Error() {
		t.Fatalf("snapshot = %#v", got)
	}
	if !got.Capabilities.SupportsRead || got.ObservedAt.After(time.Unix(1, 0)) {
		t.Fatalf("presence snapshot = %#v", got)
	}
	if store.failureCalls != 1 {
		t.Fatalf("failure writes = %d, want 1", store.failureCalls)
	}
}

func TestRegisteredRefreshOmitsProviderThatIsNotInstalled(t *testing.T) {
	store := &memoryQuotaStore{}
	service := New(store)
	reader := &testRefresher{absent: true}
	service.RegisterRefresher("claude", "default", reader)

	snapshots, err := service.RefreshAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if reader.calls.Load() != 0 || len(snapshots) != 0 {
		t.Fatalf("calls=%d snapshots=%#v", reader.calls.Load(), snapshots)
	}
	if store.failureCalls != 0 {
		t.Fatalf("failure writes = %d, want 0", store.failureCalls)
	}
}

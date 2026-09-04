package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeKimiSubscriptionReader struct {
	mu          sync.Mutex
	observation ports.KimiSubscriptionObservation
	err         error
	calls       int
	started     chan struct{}
	release     chan struct{}
}

func (f *fakeKimiSubscriptionReader) ReadKimiSubscription(ctx context.Context) (ports.KimiSubscriptionObservation, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.started != nil {
		select {
		case f.started <- struct{}{}:
		default:
		}
	}
	if f.release != nil {
		select {
		case <-f.release:
		case <-ctx.Done():
			return ports.KimiSubscriptionObservation{}, ctx.Err()
		}
	}
	return f.observation, f.err
}

func (f *fakeKimiSubscriptionReader) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func kimiSubscriptionFixture(at time.Time, used float64) ports.KimiSubscriptionObservation {
	plan := "Ultra"
	return ports.KimiSubscriptionObservation{
		Plan: &plan, AuthMethod: "oauth", ObservedAt: at,
		Limits: []domain.KimiSubscriptionLimit{{Name: "Weekly limit", UsedPercent: used, RemainingPercent: 100 - used}},
	}
}

func TestKimiSubscriptionCoordinatorCachesAndManualRefreshBypasses(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	reader := &fakeKimiSubscriptionReader{observation: kimiSubscriptionFixture(now, 40)}
	coordinator := newKimiSubscriptionCoordinator(reader, nil)
	coordinator.now = func() time.Time { return now }

	first, supported, err := coordinator.ensure(context.Background(), false)
	if err != nil || !supported || first.State != domain.KimiSubscriptionAvailable || first.RemainingPercent == nil || *first.RemainingPercent != 60 {
		t.Fatalf("first = %#v, supported=%v err=%v", first, supported, err)
	}
	if _, _, err := coordinator.ensure(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if reader.callCount() != 1 {
		t.Fatalf("cached calls = %d, want 1", reader.callCount())
	}
	reader.observation = kimiSubscriptionFixture(now.Add(time.Minute), 80)
	refreshed, _, err := coordinator.ensure(context.Background(), true)
	if err != nil || refreshed.State != domain.KimiSubscriptionNearLimit || reader.callCount() != 2 {
		t.Fatalf("refreshed = %#v calls=%d err=%v", refreshed, reader.callCount(), err)
	}
}

func TestKimiSubscriptionCoordinatorCoalescesConcurrentReads(t *testing.T) {
	now := time.Now().UTC()
	reader := &fakeKimiSubscriptionReader{
		observation: kimiSubscriptionFixture(now, 10),
		started:     make(chan struct{}, 1), release: make(chan struct{}),
	}
	coordinator := newKimiSubscriptionCoordinator(reader, nil)
	firstDone := make(chan error, 1)
	go func() {
		_, _, err := coordinator.ensure(context.Background(), false)
		firstDone <- err
	}()
	<-reader.started
	secondDone := make(chan error, 1)
	go func() {
		_, _, err := coordinator.ensure(context.Background(), false)
		secondDone <- err
	}()
	close(reader.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-secondDone; err != nil {
		t.Fatal(err)
	}
	if reader.callCount() != 1 {
		t.Fatalf("calls = %d, want 1", reader.callCount())
	}
}

func TestKimiSubscriptionCoordinatorCallerCancellationDoesNotCancelSharedRead(t *testing.T) {
	now := time.Now().UTC()
	reader := &fakeKimiSubscriptionReader{
		observation: kimiSubscriptionFixture(now, 35),
		started:     make(chan struct{}, 1), release: make(chan struct{}),
	}
	coordinator := newKimiSubscriptionCoordinator(reader, nil)
	ctx, cancel := context.WithCancel(context.Background())
	firstDone := make(chan error, 1)
	go func() {
		_, _, err := coordinator.ensure(ctx, false)
		firstDone <- err
	}()
	<-reader.started
	cancel()
	if err := <-firstDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("first error = %v, want cancellation", err)
	}
	secondDone := make(chan struct{})
	var second domain.KimiSubscriptionSnapshot
	var secondErr error
	go func() {
		second, _, secondErr = coordinator.ensure(context.Background(), false)
		close(secondDone)
	}()
	close(reader.release)
	<-secondDone
	if secondErr != nil || second.State != domain.KimiSubscriptionAvailable {
		t.Fatalf("second = %#v err=%v", second, secondErr)
	}
	if reader.callCount() != 1 {
		t.Fatalf("calls = %d, want 1", reader.callCount())
	}
}

func TestKimiSubscriptionCoordinatorPreservesLastGoodSnapshotOnFailure(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	reader := &fakeKimiSubscriptionReader{observation: kimiSubscriptionFixture(now, 20)}
	coordinator := newKimiSubscriptionCoordinator(reader, nil)
	coordinator.now = func() time.Time { return now }
	if _, _, err := coordinator.ensure(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	reader.err = errors.New("provider unavailable")
	stale, supported, err := coordinator.ensure(context.Background(), true)
	if err != nil || !supported || stale.Freshness != domain.AgentReadinessStale || stale.ReasonCode != domain.KimiSubscriptionReasonCheckFailed {
		t.Fatalf("stale = %#v, supported=%v err=%v", stale, supported, err)
	}
	if stale.RemainingPercent == nil || *stale.RemainingPercent != 80 {
		t.Fatalf("last good data was lost: %#v", stale)
	}
}

func TestKimiSubscriptionCoordinatorHidesUnsupportedConfiguration(t *testing.T) {
	reader := &fakeKimiSubscriptionReader{err: ports.ErrKimiSubscriptionUnsupported}
	coordinator := newKimiSubscriptionCoordinator(reader, nil)
	snapshot, supported, err := coordinator.ensure(context.Background(), false)
	if err != nil || supported || snapshot.ReasonCode != domain.KimiSubscriptionReasonNotChecked {
		t.Fatalf("snapshot=%#v supported=%v err=%v", snapshot, supported, err)
	}
}

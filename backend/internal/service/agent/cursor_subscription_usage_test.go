package agent

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeSubscriptionUsageReader struct {
	mu          sync.Mutex
	calls       int
	observation ports.SubscriptionUsageObservation
	err         error
}

func (f *fakeSubscriptionUsageReader) ReadSubscriptionUsage(context.Context) (ports.SubscriptionUsageObservation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.observation, f.err
}

func TestCursorSubscriptionUsageCachesAndClassifiesWorstMeter(t *testing.T) {
	reader := &fakeSubscriptionUsageReader{observation: ports.SubscriptionUsageObservation{
		Limits: []domain.SubscriptionUsageLimit{
			{ID: "included", State: domain.SubscriptionLimitActive, UsedPercent: usageFloat(20)},
			{ID: "api", State: domain.SubscriptionLimitActive, UsedPercent: usageFloat(90)},
		},
		ObservedAt: time.Date(2026, 9, 4, 8, 0, 0, 0, time.UTC),
	}}
	coordinator := newCursorSubscriptionUsageCoordinator(context.Background(), reader)
	coordinator.now = func() time.Time { return time.Date(2026, 9, 4, 8, 1, 0, 0, time.UTC) }
	readiness := readyCursorSnapshot()

	first := coordinator.ensure(context.Background(), readiness, false)
	second := coordinator.ensure(context.Background(), readiness, false)
	if reader.calls != 1 {
		t.Fatalf("calls = %d, want 1", reader.calls)
	}
	if first.State != domain.SubscriptionUsageNearLimit || first.RemainingPercent == nil || *first.RemainingPercent != 10 {
		t.Fatalf("first = %+v", first)
	}
	if second.State != first.State {
		t.Fatalf("cached = %+v", second)
	}
}

func TestCursorSubscriptionUsageAuthGateAndUnsupportedReader(t *testing.T) {
	reader := &fakeSubscriptionUsageReader{err: ports.ErrSubscriptionUsageUnsupported}
	coordinator := newCursorSubscriptionUsageCoordinator(context.Background(), reader)
	unauthorized := readyCursorSnapshot()
	unauthorized.Authentication.State = domain.AgentAuthenticationUnauthorized
	if got := coordinator.ensure(context.Background(), unauthorized, false); got.ReasonCode != domain.SubscriptionUsageReasonSignedOut || reader.calls != 0 {
		t.Fatalf("unauthorized = %+v, calls = %d", got, reader.calls)
	}
	if got := coordinator.ensure(context.Background(), readyCursorSnapshot(), true); got.State != domain.SubscriptionUsageUnsupported || reader.calls != 1 {
		t.Fatalf("unsupported = %+v, calls = %d", got, reader.calls)
	}
}

func readyCursorSnapshot() domain.AgentReadinessSnapshot {
	return domain.AgentReadinessSnapshot{
		ID:             string(domain.HarnessCursor),
		Installation:   domain.AgentInstallationObservation{State: domain.AgentInstallationInstalled},
		Authentication: domain.AgentAuthenticationObservation{State: domain.AgentAuthenticationAuthorized},
	}
}

func usageFloat(value float64) *float64 { return &value }

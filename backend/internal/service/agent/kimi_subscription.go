package agent

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	kimiSubscriptionDisplayTTL = 2 * time.Minute
	kimiSubscriptionFailureTTL = 15 * time.Second
)

// KimiSubscription is the optional hosted account shown in Settings. Custom
// providers, missing installs, and signed-out configurations remain invisible.
type KimiSubscription struct {
	Available bool                            `json:"available"`
	Capacity  domain.KimiSubscriptionSnapshot `json:"capacity"`
}

type kimiSubscriptionCall struct{ done chan struct{} }

type kimiSubscriptionCoordinator struct {
	reader ports.KimiSubscriptionReader
	logger *slog.Logger
	now    func() time.Time

	mu       sync.Mutex
	snapshot domain.KimiSubscriptionSnapshot
	call     *kimiSubscriptionCall
}

func newKimiSubscriptionCoordinator(reader ports.KimiSubscriptionReader, logger *slog.Logger) *kimiSubscriptionCoordinator {
	if logger == nil {
		logger = slog.Default()
	}
	return &kimiSubscriptionCoordinator{reader: reader, logger: logger, now: func() time.Time { return time.Now().UTC() }, snapshot: uncheckedKimiSubscription()}
}

func uncheckedKimiSubscription() domain.KimiSubscriptionSnapshot {
	return domain.KimiSubscriptionSnapshot{
		State: domain.KimiSubscriptionUnknown, Freshness: domain.AgentReadinessStale, AuthMethod: "unknown",
		ReasonCode: domain.KimiSubscriptionReasonNotChecked, Reason: "Kimi subscription usage has not been checked yet.",
		Limits: []domain.KimiSubscriptionLimit{},
	}
}

// KimiSubscription returns a live-or-cached hosted Kimi Code subscription.
// Existing readiness is only an eligibility hint; the provider read remains
// authoritative and a failed read preserves the last good snapshot as stale.
func (s *Service) KimiSubscription(ctx context.Context, force bool) (KimiSubscription, error) {
	if s.kimiUsage == nil {
		return KimiSubscription{Capacity: uncheckedKimiSubscription()}, nil
	}
	var snapshot domain.AgentReadinessSnapshot
	if force {
		items, err := s.readiness.Force(ctx, []string{string(domain.HarnessKimi)}, domain.AgentReadinessPurposeDisplay)
		if err != nil {
			return KimiSubscription{}, err
		}
		snapshot = items[0]
	} else {
		var err error
		snapshot, err = s.EnsureAgentReadiness(ctx, string(domain.HarnessKimi), domain.AgentReadinessPurposeDisplay)
		if err != nil {
			return KimiSubscription{}, err
		}
	}
	if snapshot.Installation.State != domain.AgentInstallationInstalled || snapshot.Authentication.State != domain.AgentAuthenticationAuthorized {
		return KimiSubscription{Capacity: uncheckedKimiSubscription()}, nil
	}
	capacity, supported, err := s.kimiUsage.ensure(ctx, force)
	if err != nil {
		return KimiSubscription{}, err
	}
	return KimiSubscription{Available: supported, Capacity: capacity}, nil
}

func (c *kimiSubscriptionCoordinator) ensure(ctx context.Context, force bool) (domain.KimiSubscriptionSnapshot, bool, error) {
	if err := ctx.Err(); err != nil {
		return domain.KimiSubscriptionSnapshot{}, false, err
	}
	c.mu.Lock()
	now := c.now()
	fresh := c.snapshot.CheckedAt != nil && now.Sub(*c.snapshot.CheckedAt) < kimiSubscriptionDisplayTTL && !kimiResetPassed(c.snapshot, now)
	recentFailure := c.snapshot.AttemptedAt != nil && c.snapshot.CheckedAt == nil && now.Sub(*c.snapshot.AttemptedAt) < kimiSubscriptionFailureTTL
	if !force && (fresh || recentFailure) {
		snapshot := c.snapshot
		c.mu.Unlock()
		return snapshot, true, nil
	}
	if c.call != nil {
		call := c.call
		c.mu.Unlock()
		return c.waitForKimiSubscription(ctx, call)
	}
	call := &kimiSubscriptionCall{done: make(chan struct{})}
	c.call = call
	attemptedAt := now.UTC()
	c.mu.Unlock()
	go c.readKimiSubscription(context.WithoutCancel(ctx), call, attemptedAt)
	return c.waitForKimiSubscription(ctx, call)
}

func (c *kimiSubscriptionCoordinator) waitForKimiSubscription(ctx context.Context, call *kimiSubscriptionCall) (domain.KimiSubscriptionSnapshot, bool, error) {
	select {
	case <-call.done:
		c.mu.Lock()
		snapshot := c.snapshot
		c.mu.Unlock()
		return snapshot, snapshot.ReasonCode != domain.KimiSubscriptionReasonNotChecked, nil
	case <-ctx.Done():
		return domain.KimiSubscriptionSnapshot{}, false, ctx.Err()
	}
}

func (c *kimiSubscriptionCoordinator) readKimiSubscription(ctx context.Context, call *kimiSubscriptionCall, attemptedAt time.Time) {
	observation, err := c.reader.ReadKimiSubscription(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.call == call {
		c.call = nil
		close(call.done)
	}
	if errors.Is(err, ports.ErrKimiSubscriptionUnsupported) {
		c.snapshot = uncheckedKimiSubscription()
		return
	}
	if err != nil {
		if c.snapshot.CheckedAt == nil {
			c.snapshot = uncheckedKimiSubscription()
		}
		c.snapshot.Freshness = domain.AgentReadinessStale
		c.snapshot.AttemptedAt = &attemptedAt
		c.snapshot.ReasonCode = domain.KimiSubscriptionReasonCheckFailed
		c.snapshot.Reason = "Kimi subscription usage could not be checked."
		c.logger.Info("Kimi subscription usage read failed", "failure_category", "provider_read")
		return
	}
	checkedAt := c.now().UTC()
	c.snapshot = kimiSubscriptionFromObservation(observation, attemptedAt, checkedAt)
}

func kimiSubscriptionFromObservation(observation ports.KimiSubscriptionObservation, attemptedAt, checkedAt time.Time) domain.KimiSubscriptionSnapshot {
	limits := append([]domain.KimiSubscriptionLimit(nil), observation.Limits...)
	snapshot := domain.KimiSubscriptionSnapshot{
		State: domain.KimiSubscriptionUnknown, Freshness: domain.AgentReadinessFresh,
		Plan: observation.Plan, AuthMethod: observation.AuthMethod, Limits: limits,
		ReasonCode: domain.KimiSubscriptionReasonNotChecked, Reason: "Kimi did not report a trustworthy subscription limit.",
	}
	if snapshot.AuthMethod == "" {
		snapshot.AuthMethod = "unknown"
	}
	observedAt := observation.ObservedAt.UTC()
	if observedAt.IsZero() {
		observedAt = checkedAt.UTC()
	}
	attemptedAt, checkedAt = attemptedAt.UTC(), checkedAt.UTC()
	snapshot.ObservedAt, snapshot.CheckedAt, snapshot.AttemptedAt = &observedAt, &checkedAt, &attemptedAt
	var worst *domain.KimiSubscriptionLimit
	for i := range limits {
		if worst == nil || limits[i].UsedPercent > worst.UsedPercent {
			worst = &limits[i]
		}
	}
	if worst == nil {
		return snapshot
	}
	used, remaining := worst.UsedPercent, worst.RemainingPercent
	snapshot.UsedPercent, snapshot.RemainingPercent, snapshot.ResetsAt = &used, &remaining, worst.ResetsAt
	switch {
	case used >= 100 || remaining <= 0:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.KimiSubscriptionExhausted, domain.KimiSubscriptionReasonExhausted, "Kimi reports that this subscription has reached its limit."
	case used >= 75:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.KimiSubscriptionNearLimit, domain.KimiSubscriptionReasonNearLimit, "Kimi reports that this subscription is near its limit."
	default:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.KimiSubscriptionAvailable, domain.KimiSubscriptionReasonAvailable, "Kimi reports subscription capacity is available."
	}
	return snapshot
}

func kimiResetPassed(snapshot domain.KimiSubscriptionSnapshot, now time.Time) bool {
	for i := range snapshot.Limits {
		if reset := snapshot.Limits[i].ResetsAt; reset != nil && !now.Before(*reset) {
			return true
		}
	}
	return false
}

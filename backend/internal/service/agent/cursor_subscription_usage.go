package agent

import (
	"context"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	cursorSubscriptionUsageTTL     = 2 * time.Minute
	cursorSubscriptionUsageTimeout = 20 * time.Second
)

type cursorSubscriptionUsageCall struct{ done chan struct{} }

type cursorSubscriptionUsageCoordinator struct {
	ctx    context.Context
	reader ports.SubscriptionUsageReader
	now    func() time.Time

	mu          sync.Mutex
	snapshot    domain.SubscriptionUsageSnapshot
	invalidated bool
	call        *cursorSubscriptionUsageCall
}

func newCursorSubscriptionUsageCoordinator(ctx context.Context, reader ports.SubscriptionUsageReader) *cursorSubscriptionUsageCoordinator {
	if ctx == nil {
		ctx = context.Background()
	}
	return &cursorSubscriptionUsageCoordinator{
		ctx: ctx, reader: reader, now: func() time.Time { return time.Now().UTC() },
		snapshot: uncheckedSubscriptionUsage(), invalidated: true,
	}
}

func uncheckedSubscriptionUsage() domain.SubscriptionUsageSnapshot {
	return domain.SubscriptionUsageSnapshot{
		State: domain.SubscriptionUsageUnknown, Freshness: domain.AgentReadinessStale,
		ReasonCode: domain.SubscriptionUsageReasonNotChecked, Reason: "Cursor subscription usage has not been checked yet.",
		Limits: []domain.SubscriptionUsageLimit{},
	}
}

func staticSubscriptionUsage(state domain.SubscriptionUsageState, code, reason string) domain.SubscriptionUsageSnapshot {
	return domain.SubscriptionUsageSnapshot{
		State: state, Freshness: domain.AgentReadinessFresh, ReasonCode: code, Reason: reason,
		Limits: []domain.SubscriptionUsageLimit{},
	}
}

func (c *cursorSubscriptionUsageCoordinator) cached() domain.SubscriptionUsageSnapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cloneSubscriptionUsage(c.snapshot)
}

func (c *cursorSubscriptionUsageCoordinator) invalidate() {
	c.mu.Lock()
	c.invalidated = true
	if c.snapshot.CheckedAt != nil {
		c.snapshot.Freshness = domain.AgentReadinessStale
	}
	c.mu.Unlock()
}

func (c *cursorSubscriptionUsageCoordinator) ensure(ctx context.Context, readiness domain.AgentReadinessSnapshot, force bool) domain.SubscriptionUsageSnapshot {
	if readiness.Installation.State == domain.AgentInstallationNotInstalled {
		return c.replace(staticSubscriptionUsage(domain.SubscriptionUsageUnsupported, domain.SubscriptionUsageReasonUnsupported, "Install Cursor Agent to see subscription usage."))
	}
	switch readiness.Authentication.State {
	case domain.AgentAuthenticationUnauthorized:
		return c.replace(staticSubscriptionUsage(domain.SubscriptionUsageUnknown, domain.SubscriptionUsageReasonSignedOut, "Sign in to Cursor to see subscription usage."))
	case domain.AgentAuthenticationUnknown:
		return c.preserveFailure(domain.SubscriptionUsageReasonAuthUnknown, "Confirm Cursor authentication before checking subscription usage.")
	}

	c.mu.Lock()
	now := c.now()
	fresh := c.snapshot.CheckedAt != nil && now.Sub(*c.snapshot.CheckedAt) < cursorSubscriptionUsageTTL
	if !force && !c.invalidated && fresh {
		result := cloneSubscriptionUsage(c.snapshot)
		c.mu.Unlock()
		return result
	}
	if c.call != nil {
		call := c.call
		c.mu.Unlock()
		select {
		case <-call.done:
			return c.cached()
		case <-ctx.Done():
			return c.cached()
		}
	}
	call := &cursorSubscriptionUsageCall{done: make(chan struct{})}
	c.call = call
	attemptedAt := now.UTC()
	c.snapshot.Freshness = domain.AgentReadinessChecking
	c.snapshot.ReasonCode = domain.SubscriptionUsageReasonChecking
	c.snapshot.Reason = "Checking Cursor subscription usage."
	c.snapshot.AttemptedAt = &attemptedAt
	c.mu.Unlock()

	go c.runRead(call, attemptedAt)
	select {
	case <-call.done:
		return c.cached()
	case <-ctx.Done():
		return c.cached()
	}
}

func (c *cursorSubscriptionUsageCoordinator) runRead(call *cursorSubscriptionUsageCall, attemptedAt time.Time) {
	readCtx, cancel := context.WithTimeout(c.ctx, cursorSubscriptionUsageTimeout)
	defer cancel()
	observation, err := c.reader.ReadSubscriptionUsage(readCtx)
	checkedAt := c.now().UTC()

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.call != call {
		return
	}
	defer func() { c.call = nil; close(call.done) }()
	if err != nil {
		if errors.Is(err, ports.ErrSubscriptionUsageUnsupported) {
			c.snapshot = staticSubscriptionUsage(domain.SubscriptionUsageUnsupported, domain.SubscriptionUsageReasonUnsupported, "Subscription usage is not supported by this Cursor version or authentication method.")
			c.invalidated = false
			return
		}
		if c.snapshot.CheckedAt == nil {
			c.snapshot = uncheckedSubscriptionUsage()
		} else {
			c.snapshot.Freshness = domain.AgentReadinessStale
		}
		c.snapshot.AttemptedAt = &attemptedAt
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(readCtx.Err(), context.DeadlineExceeded) {
			c.snapshot.ReasonCode, c.snapshot.Reason = domain.SubscriptionUsageReasonCheckTimeout, "Cursor subscription usage check timed out."
		} else {
			c.snapshot.ReasonCode, c.snapshot.Reason = domain.SubscriptionUsageReasonCheckFailed, "Cursor subscription usage could not be checked."
		}
		c.invalidated = true
		return
	}
	c.snapshot = subscriptionUsageSnapshot(observation, attemptedAt, checkedAt)
	c.invalidated = false
}

func subscriptionUsageSnapshot(observation ports.SubscriptionUsageObservation, attemptedAt, checkedAt time.Time) domain.SubscriptionUsageSnapshot {
	observedAt := observation.ObservedAt.UTC()
	if observedAt.IsZero() {
		observedAt = checkedAt
	}
	snapshot := domain.SubscriptionUsageSnapshot{
		State: domain.SubscriptionUsageUnknown, Freshness: domain.AgentReadinessFresh,
		Plan: observation.Plan, ObservedAt: &observedAt, CheckedAt: &checkedAt, AttemptedAt: &attemptedAt,
		ReasonCode: domain.SubscriptionUsageReasonCheckInconclusive,
		Reason:     "Cursor did not report a trustworthy subscription capacity meter.",
		Limits:     append([]domain.SubscriptionUsageLimit(nil), observation.Limits...),
	}
	var worst *float64
	for i := range snapshot.Limits {
		used := snapshot.Limits[i].UsedPercent
		if used != nil && (worst == nil || *used > *worst) {
			value := math.Min(100, math.Max(0, *used))
			worst = &value
		}
	}
	if worst == nil {
		return snapshot
	}
	used, remaining := *worst, 100-*worst
	snapshot.UsedPercent, snapshot.RemainingPercent = &used, &remaining
	switch {
	case used >= 100:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.SubscriptionUsageExhausted, domain.SubscriptionUsageReasonExhausted, "Cursor reports that subscription capacity is exhausted."
	case used >= 75:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.SubscriptionUsageNearLimit, domain.SubscriptionUsageReasonNearLimit, "Cursor reports that subscription capacity is near its limit."
	default:
		snapshot.State, snapshot.ReasonCode, snapshot.Reason = domain.SubscriptionUsageAvailable, domain.SubscriptionUsageReasonAvailable, "Cursor subscription capacity is available."
	}
	return snapshot
}

func (c *cursorSubscriptionUsageCoordinator) replace(snapshot domain.SubscriptionUsageSnapshot) domain.SubscriptionUsageSnapshot {
	c.mu.Lock()
	c.snapshot = snapshot
	c.invalidated = false
	c.mu.Unlock()
	return cloneSubscriptionUsage(snapshot)
}

func (c *cursorSubscriptionUsageCoordinator) preserveFailure(code, reason string) domain.SubscriptionUsageSnapshot {
	c.mu.Lock()
	if c.snapshot.CheckedAt == nil {
		c.snapshot = uncheckedSubscriptionUsage()
	} else {
		c.snapshot.Freshness = domain.AgentReadinessStale
	}
	c.snapshot.ReasonCode, c.snapshot.Reason = code, reason
	c.invalidated = true
	result := cloneSubscriptionUsage(c.snapshot)
	c.mu.Unlock()
	return result
}

func cloneSubscriptionUsage(snapshot domain.SubscriptionUsageSnapshot) domain.SubscriptionUsageSnapshot {
	snapshot.Limits = append([]domain.SubscriptionUsageLimit(nil), snapshot.Limits...)
	return snapshot
}

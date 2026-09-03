package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func initialClaudeCodePlanUsage(account domain.ClaudeCodeAccountSnapshot) domain.ClaudeCodePlanUsageSnapshot {
	plan := claudeCodeAccountPlan(account.Identity)
	if account.Status == domain.ClaudeCodeAccountStatusSignedOut {
		return domain.ClaudeCodePlanUsageSnapshot{
			State: domain.ClaudeCodePlanUsageUnknown, Freshness: domain.AgentReadinessStale,
			Plan: plan, Windows: []domain.ClaudeCodePlanUsageWindow{},
			ReasonCode: domain.ClaudeCodePlanUsageReasonSignedOut, Reason: "Sign in to view plan usage.",
		}
	}
	return domain.ClaudeCodePlanUsageSnapshot{
		State: domain.ClaudeCodePlanUsageUnknown, Freshness: domain.AgentReadinessStale,
		Plan: plan, Windows: []domain.ClaudeCodePlanUsageWindow{},
		ReasonCode: domain.ClaudeCodePlanUsageReasonNotChecked, Reason: "Plan usage has not been checked yet.",
	}
}

func unsupportedClaudeCodePlanUsage(account domain.ClaudeCodeAccountSnapshot) domain.ClaudeCodePlanUsageSnapshot {
	return domain.ClaudeCodePlanUsageSnapshot{
		State: domain.ClaudeCodePlanUsageUnsupported, Freshness: domain.AgentReadinessStale,
		Plan: claudeCodeAccountPlan(account.Identity), Windows: []domain.ClaudeCodePlanUsageWindow{},
		ReasonCode: domain.ClaudeCodePlanUsageReasonUnsupported, Reason: "Plan usage is not supported here.",
	}
}

func claudeCodeAccountPlan(identity domain.ClaudeCodeAccountIdentity) *string {
	for _, value := range []string{identity.SeatTier, identity.BillingType} {
		value = strings.ToLower(strings.TrimSpace(value))
		value = strings.TrimPrefix(value, "claude_")
		switch value {
		case "free", "pro", "max", "team", "business", "enterprise":
			return &value
		}
	}
	return nil
}

func (m *claudeCodeAccountManager) resetPlanUsage(accountID string) {
	record, ok := m.catalog.record(accountID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if !ok {
		delete(m.planUsage, accountID)
		return
	}
	m.planUsage[accountID] = initialClaudeCodePlanUsage(record.Snapshot)
}

// refreshUsage refreshes display-only plan limits without changing the active Claude account.
// Failures leave account management usable and retain the last successful values as stale.
func (m *claudeCodeAccountManager) refreshUsage(ctx context.Context) {
	if m.usageReader == nil {
		return
	}
	now := m.now()
	accounts := m.catalog.snapshots("")
	m.mu.Lock()
	if m.caps.AccountRead.State != domain.ClaudeCodeCapabilitySupported {
		for _, account := range accounts {
			m.planUsage[account.ID] = unsupportedClaudeCodePlanUsage(account)
		}
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	accountByID := make(map[string]domain.ClaudeCodeAccountSnapshot, len(accounts))
	accountIDs := make([]string, 0, len(accounts))

	m.mu.Lock()
	for _, account := range accounts {
		accountByID[account.ID] = account
		if account.Status != domain.ClaudeCodeAccountStatusValid {
			m.planUsage[account.ID] = initialClaudeCodePlanUsage(account)
			continue
		}
		previous, ok := m.planUsage[account.ID]
		if ok && previous.AttemptedAt != nil && now.Sub(*previous.AttemptedAt) < claudeCodeUsageCacheLifetime {
			continue
		}
		attemptedAt := now
		if !ok {
			previous = initialClaudeCodePlanUsage(account)
		}
		previous.State = domain.ClaudeCodePlanUsageUnknown
		previous.Freshness = domain.AgentReadinessChecking
		previous.AttemptedAt = &attemptedAt
		previous.ReasonCode = domain.ClaudeCodePlanUsageReasonChecking
		previous.Reason = "Checking plan usage."
		m.planUsage[account.ID] = previous
		accountIDs = append(accountIDs, account.ID)
	}
	m.mu.Unlock()

	var wait sync.WaitGroup
	for _, accountID := range accountIDs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			requestCtx, cancel := context.WithTimeout(ctx, 7*time.Second)
			defer cancel()
			observation, err := m.usageReader.ReadPlanUsage(requestCtx, accountID)
			m.storePlanUsageResult(accountByID[accountID], observation, err, now)
		}()
	}
	wait.Wait()
}

func (m *claudeCodeAccountManager) storePlanUsageResult(account domain.ClaudeCodeAccountSnapshot, observation ports.ClaudeCodePlanUsageObservation, err error, checkedAt time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.planUsage[account.ID]
	attemptedAt := checkedAt
	if previous.AttemptedAt != nil {
		attemptedAt = *previous.AttemptedAt
	}
	if err == nil {
		observedAt := observation.ObservedAt
		plan := observation.Plan
		if plan == nil {
			plan = claudeCodeAccountPlan(account.Identity)
		}
		var promotion *domain.ClaudeCodePlanPromotion
		if observation.Promotion != nil {
			promotionCopy := *observation.Promotion
			promotion = &promotionCopy
		}
		m.planUsage[account.ID] = domain.ClaudeCodePlanUsageSnapshot{
			State: domain.ClaudeCodePlanUsageAvailable, Freshness: domain.AgentReadinessFresh,
			Plan: plan, Promotion: promotion, Windows: append([]domain.ClaudeCodePlanUsageWindow(nil), observation.Windows...),
			ObservedAt: &observedAt, CheckedAt: &checkedAt, AttemptedAt: &attemptedAt,
			ReasonCode: domain.ClaudeCodePlanUsageReasonAvailable, Reason: "Plan usage is up to date.",
		}
		return
	}
	previous.State = domain.ClaudeCodePlanUsageUnknown
	previous.Freshness = domain.AgentReadinessStale
	previous.CheckedAt = &checkedAt
	previous.AttemptedAt = &attemptedAt
	if observation.Plan != nil {
		previous.Plan = observation.Plan
	} else if previous.Plan == nil {
		previous.Plan = claudeCodeAccountPlan(account.Identity)
	}
	if observation.Promotion != nil {
		promotion := *observation.Promotion
		previous.Promotion = &promotion
	}
	if previous.Windows == nil {
		previous.Windows = []domain.ClaudeCodePlanUsageWindow{}
	}
	switch {
	case errors.Is(err, ports.ErrClaudeCodePlanUsageRateLimited):
		previous.ReasonCode = domain.ClaudeCodePlanUsageReasonRateLimited
		previous.Reason = "Plan usage will refresh again shortly."
	case errors.Is(err, ports.ErrClaudeCodePlanUsageInvalid):
		previous.ReasonCode = domain.ClaudeCodePlanUsageReasonInvalidResponse
		previous.Reason = "Claude did not return usable plan usage."
	default:
		previous.ReasonCode = domain.ClaudeCodePlanUsageReasonUnavailable
		previous.Reason = "Plan usage is temporarily unavailable."
	}
	m.planUsage[account.ID] = previous
}

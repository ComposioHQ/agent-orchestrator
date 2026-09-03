package domain

import "time"

// ClaudeCodePlanUsageState classifies whether subscription limits can be shown.
type ClaudeCodePlanUsageState string

// Claude Code plan-usage states.
const (
	ClaudeCodePlanUsageAvailable   ClaudeCodePlanUsageState = "available"
	ClaudeCodePlanUsageUnknown     ClaudeCodePlanUsageState = "unknown"
	ClaudeCodePlanUsageUnsupported ClaudeCodePlanUsageState = "unsupported"
)

// ClaudeCodePlanUsageWindow is one provider-reported subscription limit.
type ClaudeCodePlanUsageWindow struct {
	ID          string     `json:"id"`
	DisplayName string     `json:"displayName"`
	UsedPercent float64    `json:"usedPercent" minimum:"0" maximum:"100"`
	ResetsAt    *time.Time `json:"resetsAt,omitempty"`
}

// ClaudeCodePlanPromotion is a display-safe active subscription promotion.
type ClaudeCodePlanPromotion struct {
	PercentIncrease int    `json:"percentIncrease" minimum:"1"`
	EndsOn          string `json:"endsOn"`
}

// ClaudeCodePlanUsageSnapshot is the display-safe cached usage state for one account.
type ClaudeCodePlanUsageSnapshot struct {
	State       ClaudeCodePlanUsageState    `json:"state" enum:"available,unknown,unsupported"`
	Freshness   AgentReadinessFreshness     `json:"freshness" enum:"fresh,stale,checking"`
	Plan        *string                     `json:"plan,omitempty"`
	Promotion   *ClaudeCodePlanPromotion    `json:"promotion,omitempty"`
	Windows     []ClaudeCodePlanUsageWindow `json:"windows"`
	ObservedAt  *time.Time                  `json:"observedAt,omitempty"`
	CheckedAt   *time.Time                  `json:"checkedAt,omitempty"`
	AttemptedAt *time.Time                  `json:"attemptedAt,omitempty"`
	ReasonCode  string                      `json:"reasonCode"`
	Reason      string                      `json:"reason"`
}

// Claude Code plan-usage reason codes are stable, display-safe explanations.
const (
	ClaudeCodePlanUsageReasonNotChecked      = "plan_usage_not_checked"
	ClaudeCodePlanUsageReasonChecking        = "plan_usage_checking"
	ClaudeCodePlanUsageReasonAvailable       = "plan_usage_available"
	ClaudeCodePlanUsageReasonSignedOut       = "plan_usage_signed_out"
	ClaudeCodePlanUsageReasonUnavailable     = "plan_usage_unavailable"
	ClaudeCodePlanUsageReasonRateLimited     = "plan_usage_rate_limited"
	ClaudeCodePlanUsageReasonUnsupported     = "plan_usage_unsupported"
	ClaudeCodePlanUsageReasonInvalidResponse = "plan_usage_invalid_response"
)

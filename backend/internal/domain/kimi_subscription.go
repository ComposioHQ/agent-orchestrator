package domain

import "time"

// KimiSubscriptionState is the display-safe classification of the active
// hosted Kimi Code subscription. It is advisory and never gates launches.
type KimiSubscriptionState string

const (
	// KimiSubscriptionAvailable means the provider reports usable capacity.
	KimiSubscriptionAvailable KimiSubscriptionState = "available"
	// KimiSubscriptionNearLimit means remaining capacity is low.
	KimiSubscriptionNearLimit KimiSubscriptionState = "near_limit"
	// KimiSubscriptionExhausted means the provider reports no remaining capacity.
	KimiSubscriptionExhausted KimiSubscriptionState = "exhausted"
	// KimiSubscriptionUnknown means no trustworthy classification is available.
	KimiSubscriptionUnknown KimiSubscriptionState = "unknown"
)

// KimiSubscriptionLimit is one provider-reported subscription window.
type KimiSubscriptionLimit struct {
	Name                  string     `json:"name"`
	UsedPercent           float64    `json:"usedPercent" minimum:"0" maximum:"100"`
	RemainingPercent      float64    `json:"remainingPercent" minimum:"0" maximum:"100"`
	WindowDurationMinutes *int64     `json:"windowDurationMinutes,omitempty"`
	ResetsAt              *time.Time `json:"resetsAt,omitempty"`
}

// KimiSubscriptionSnapshot is the daemon-memory view of the active hosted
// account. Tokens, raw provider payloads, and custom-provider details are never
// retained or exposed.
type KimiSubscriptionSnapshot struct {
	State            KimiSubscriptionState   `json:"state" enum:"available,near_limit,exhausted,unknown"`
	Freshness        AgentReadinessFreshness `json:"freshness" enum:"fresh,stale,checking"`
	Plan             *string                 `json:"plan,omitempty"`
	AuthMethod       string                  `json:"authMethod" enum:"oauth,api_key,unknown"`
	UsedPercent      *float64                `json:"usedPercent,omitempty" minimum:"0" maximum:"100"`
	RemainingPercent *float64                `json:"remainingPercent,omitempty" minimum:"0" maximum:"100"`
	ResetsAt         *time.Time              `json:"resetsAt,omitempty"`
	ObservedAt       *time.Time              `json:"observedAt,omitempty"`
	CheckedAt        *time.Time              `json:"checkedAt,omitempty"`
	AttemptedAt      *time.Time              `json:"attemptedAt,omitempty"`
	ReasonCode       string                  `json:"reasonCode"`
	Reason           string                  `json:"reason"`
	Limits           []KimiSubscriptionLimit `json:"limits"`
}

const (
	// KimiSubscriptionReasonNotChecked means no authoritative read is available.
	KimiSubscriptionReasonNotChecked = "kimi_subscription_not_checked"
	// KimiSubscriptionReasonAvailable explains an available classification.
	KimiSubscriptionReasonAvailable = "kimi_subscription_available"
	// KimiSubscriptionReasonNearLimit explains a near-limit classification.
	KimiSubscriptionReasonNearLimit = "kimi_subscription_near_limit"
	// KimiSubscriptionReasonExhausted explains an exhausted classification.
	KimiSubscriptionReasonExhausted = "kimi_subscription_exhausted"
	// KimiSubscriptionReasonCheckFailed explains a stale failed refresh.
	KimiSubscriptionReasonCheckFailed = "kimi_subscription_check_failed"
)

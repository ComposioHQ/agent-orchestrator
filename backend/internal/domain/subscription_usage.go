package domain

import "time"

// SubscriptionUsageState is the display-safe classification of one harness
// account's provider-reported subscription capacity. It is advisory and never
// participates in launch admission.
type SubscriptionUsageState string

// Subscription usage states classify the provider-reported overall capacity.
const (
	SubscriptionUsageAvailable   SubscriptionUsageState = "available"
	SubscriptionUsageNearLimit   SubscriptionUsageState = "near_limit"
	SubscriptionUsageExhausted   SubscriptionUsageState = "exhausted"
	SubscriptionUsageUnknown     SubscriptionUsageState = "unknown"
	SubscriptionUsageUnsupported SubscriptionUsageState = "unsupported"
)

// SubscriptionLimitState represents provider states that cannot be expressed
// as a percentage, such as unlimited or disabled on-demand spend.
type SubscriptionLimitState string

// Subscription limit states normalize numeric and non-numeric provider limits.
const (
	SubscriptionLimitActive      SubscriptionLimitState = "active"
	SubscriptionLimitUnlimited   SubscriptionLimitState = "unlimited"
	SubscriptionLimitDisabled    SubscriptionLimitState = "disabled"
	SubscriptionLimitUnavailable SubscriptionLimitState = "unavailable"
)

// SubscriptionUsageLimit is one provider meter. Percentage and absolute-value
// fields are optional because providers expose different subscription models.
type SubscriptionUsageLimit struct {
	ID               string                 `json:"id"`
	Name             string                 `json:"name"`
	State            SubscriptionLimitState `json:"state" enum:"active,unlimited,disabled,unavailable"`
	UsedPercent      *float64               `json:"usedPercent,omitempty" minimum:"0" maximum:"100"`
	RemainingPercent *float64               `json:"remainingPercent,omitempty" minimum:"0" maximum:"100"`
	UsedValue        *float64               `json:"usedValue,omitempty" minimum:"0"`
	TotalValue       *float64               `json:"totalValue,omitempty" minimum:"0"`
	RemainingValue   *float64               `json:"remainingValue,omitempty" minimum:"0"`
	Unit             string                 `json:"unit,omitempty"`
	ResetsAt         *time.Time             `json:"resetsAt,omitempty" format:"date-time"`
}

// SubscriptionUsageSnapshot is the daemon-memory capacity observation exposed
// with a harness readiness snapshot. Raw provider payloads and credentials are
// deliberately absent.
type SubscriptionUsageSnapshot struct {
	State            SubscriptionUsageState   `json:"state" enum:"available,near_limit,exhausted,unknown,unsupported"`
	Freshness        AgentReadinessFreshness  `json:"freshness" enum:"fresh,stale,checking"`
	Plan             *string                  `json:"plan,omitempty"`
	UsedPercent      *float64                 `json:"usedPercent,omitempty" minimum:"0" maximum:"100"`
	RemainingPercent *float64                 `json:"remainingPercent,omitempty" minimum:"0" maximum:"100"`
	ObservedAt       *time.Time               `json:"observedAt,omitempty" format:"date-time"`
	CheckedAt        *time.Time               `json:"checkedAt,omitempty" format:"date-time"`
	AttemptedAt      *time.Time               `json:"attemptedAt,omitempty" format:"date-time"`
	ReasonCode       string                   `json:"reasonCode"`
	Reason           string                   `json:"reason"`
	Limits           []SubscriptionUsageLimit `json:"limits"`
}

// Subscription usage reason codes are stable, display-safe explanations.
const (
	SubscriptionUsageReasonNotChecked        = "subscription_usage_not_checked"
	SubscriptionUsageReasonChecking          = "subscription_usage_checking"
	SubscriptionUsageReasonAvailable         = "subscription_usage_available"
	SubscriptionUsageReasonNearLimit         = "subscription_usage_near_limit"
	SubscriptionUsageReasonExhausted         = "subscription_usage_exhausted"
	SubscriptionUsageReasonUnsupported       = "subscription_usage_unsupported"
	SubscriptionUsageReasonSignedOut         = "subscription_usage_signed_out"
	SubscriptionUsageReasonAuthUnknown       = "subscription_usage_auth_unknown"
	SubscriptionUsageReasonCheckFailed       = "subscription_usage_check_failed"
	SubscriptionUsageReasonCheckTimeout      = "subscription_usage_check_timeout"
	SubscriptionUsageReasonCheckInconclusive = "subscription_usage_check_inconclusive"
)

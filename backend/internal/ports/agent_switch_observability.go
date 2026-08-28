package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DeliveryOutcome is the complete provider-neutral result of one bounded
// delivery attempt. Cancellation values are local control decisions.
type DeliveryOutcome string

const (
	DeliveryAccepted          DeliveryOutcome = "accepted"
	DeliveryTransientFailure  DeliveryOutcome = "transient_failure"
	DeliveryPermanentFailure  DeliveryOutcome = "permanent_failure"
	DeliveryPolicyCancelled   DeliveryOutcome = "policy_cancelled"
	DeliveryShutdownCancelled DeliveryOutcome = "shutdown_cancelled"
)

// DeliveryErrorClass contains no provider response text or raw error.
type DeliveryErrorClass string

const (
	DeliveryErrorNone                DeliveryErrorClass = "none"
	DeliveryErrorNetwork             DeliveryErrorClass = "network"
	DeliveryErrorTimeout             DeliveryErrorClass = "timeout"
	DeliveryErrorRateLimited         DeliveryErrorClass = "rate_limited"
	DeliveryErrorProviderUnavailable DeliveryErrorClass = "provider_unavailable"
	DeliveryResponseLost             DeliveryErrorClass = "response_lost"
	DeliveryErrorInvalidPayload      DeliveryErrorClass = "invalid_payload"
	DeliveryErrorUnauthorized        DeliveryErrorClass = "unauthorized"
	DeliveryErrorUnsupportedEncoding DeliveryErrorClass = "unsupported_encoding"
	DeliveryErrorLocalInvariant      DeliveryErrorClass = "local_invariant"
)

type DeliveryThrottleScope string

const (
	DeliveryThrottleNone          DeliveryThrottleScope = "none"
	DeliveryThrottleErrorCategory DeliveryThrottleScope = "error_category"
	DeliveryThrottleAll           DeliveryThrottleScope = "all"
)

type DeliveryResult struct {
	Outcome        DeliveryOutcome
	Class          DeliveryErrorClass
	RetryNotBefore time.Time
	ThrottleScope  DeliveryThrottleScope
}

// AgentSwitchFailureObserver receives immutable privacy-allowlisted bytes. It
// cannot read or mutate saga state and must acknowledge synchronously.
type AgentSwitchFailureObserver interface {
	ObserveAgentSwitchFailure(context.Context, domain.AgentSwitchFailureEvent) DeliveryResult
}

// AgentSwitchReportingPolicy supplies the current transaction-bound authority
// snapshot. Storage still performs the authoritative in-transaction check.
type AgentSwitchReportingPolicy interface {
	Authorization() domain.AgentSwitchReportingAuthorization
}

package ports

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ErrSubscriptionUsageUnsupported means the installed harness or current
// authentication method has no AO-verified structured usage reader.
var ErrSubscriptionUsageUnsupported = errors.New("subscription usage is unsupported")

// SubscriptionUsageObservation is normalized provider data before cache
// freshness and display-safe reasons are applied by the service coordinator.
type SubscriptionUsageObservation struct {
	Plan       *string
	Limits     []domain.SubscriptionUsageLimit
	ObservedAt time.Time
}

// SubscriptionUsageReader reads a credential-free subscription usage model.
type SubscriptionUsageReader interface {
	ReadSubscriptionUsage(context.Context) (SubscriptionUsageObservation, error)
}

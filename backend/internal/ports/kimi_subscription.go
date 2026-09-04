package ports

import (
	"context"
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ErrKimiSubscriptionUnsupported means the effective Kimi configuration is
// not the hosted Kimi Code subscription service. Callers must not retry it
// against api.kimi.com with a custom-provider credential.
var ErrKimiSubscriptionUnsupported = errors.New("hosted Kimi Code subscription usage is unavailable")

// KimiSubscriptionObservation is the safe, normalized subset of /usages.
type KimiSubscriptionObservation struct {
	Plan       *string
	AuthMethod string
	Limits     []domain.KimiSubscriptionLimit
	ObservedAt time.Time
}

// KimiSubscriptionReader reads the active hosted Kimi Code subscription
// without starting a visible AO session.
type KimiSubscriptionReader interface {
	ReadKimiSubscription(context.Context) (KimiSubscriptionObservation, error)
}

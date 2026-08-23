package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// NotificationSubscriber is the live notification fan-out boundary. Hosted
// implementations scope subscriptions to the tenant in ctx; local adapters
// are single tenant. Durable catch-up remains the notification list API.
type NotificationSubscriber interface {
	SubscribeNotifications(
		ctx context.Context,
		projectID domain.ProjectID,
	) (events <-chan domain.NotificationEvent, unsubscribe func(), err error)
}

// NotificationIntent is the lifecycle-to-notification-producer contract. It is
// not an HTTP DTO; lifecycle fills it from facts it already has after the
// underlying session/PR state write succeeds.
type NotificationIntent struct {
	Type      domain.NotificationType
	SessionID domain.SessionID
	ProjectID domain.ProjectID
	PRURL     string
	CreatedAt time.Time

	// Enrichment hints. These avoid storage reads on the hot path.
	SessionDisplayName string
	PRNumber           int
	PRTitle            string
	PRSourceBranch     string
	PRTargetBranch     string
	Provider           string
	Repo               string
}

// NotificationResolution is the lifecycle-to-notification-producer contract for
// closing notifications whose underlying issue went away. Lifecycle fills it
// after the durable fact that resolves the issue is written — the session left
// the needs-input family, the PR stopped waiting on a merge.
//
// PRURL wins when set (a PR-scoped notification can outlive its session's
// activity churn); otherwise the resolution is scoped to SessionID.
type NotificationResolution struct {
	Type       domain.NotificationType
	SessionID  domain.SessionID
	PRURL      string
	ResolvedAt time.Time
}

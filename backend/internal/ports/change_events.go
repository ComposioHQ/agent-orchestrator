package ports

import (
	"context"
	"encoding/json"
	"time"
)

// ChangeEventType identifies the durable fact invalidated by a product write.
// Values are part of the client-facing event contract and must remain stable.
type ChangeEventType string

const (
	ChangeEventProjectCreated         ChangeEventType = "project_created"
	ChangeEventProjectUpdated         ChangeEventType = "project_updated"
	ChangeEventSessionCreated         ChangeEventType = "session_created"
	ChangeEventSessionUpdated         ChangeEventType = "session_updated"
	ChangeEventPRCreated              ChangeEventType = "pr_created"
	ChangeEventPRUpdated              ChangeEventType = "pr_updated"
	ChangeEventPRCheckRecorded        ChangeEventType = "pr_check_recorded"
	ChangeEventPRSessionChanged       ChangeEventType = "pr_session_changed"
	ChangeEventPRReviewThreadAdded    ChangeEventType = "pr_review_thread_added"
	ChangeEventPRReviewThreadResolved ChangeEventType = "pr_review_thread_resolved"
	ChangeEventPRCommentRecorded      ChangeEventType = "pr_comment_recorded"
	ChangeEventPRReviewRecorded       ChangeEventType = "pr_review_recorded"
	ChangeEventReviewRunCreated       ChangeEventType = "review_run_created"
	ChangeEventReviewRunUpdated       ChangeEventType = "review_run_updated"
	ChangeEventNotificationCreated    ChangeEventType = "notification_created"
	ChangeEventNotificationResolved   ChangeEventType = "notification_resolved"
)

// ChangeEvent is one committed event from a durable change log. Seq is scoped
// to the tenant selected by ctx and is both the replay cursor and idempotency
// key. SessionID is empty for project-level events.
type ChangeEvent struct {
	Seq       int64           `json:"seq"`
	ProjectID string          `json:"projectId"`
	SessionID string          `json:"sessionId,omitempty"`
	Type      ChangeEventType `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"createdAt"`
}

// ChangeEventSource is the durable replay boundary. Hosted implementations
// scope every call to the tenant in ctx; local implementations are inherently
// single tenant.
type ChangeEventSource interface {
	EventsAfter(ctx context.Context, after int64, limit int) ([]ChangeEvent, error)
	LatestSeq(ctx context.Context) (int64, error)
}

// ChangeEventSubscriber is the live wake-up boundary layered on durable
// replay. Implementations scope subscriptions to the tenant in ctx. Delivery
// may overlap durable replay, so consumers must suppress sequence values they
// have already observed.
type ChangeEventSubscriber interface {
	SubscribeChanges(ctx context.Context, fn func(ChangeEvent)) (unsubscribe func(), err error)
}

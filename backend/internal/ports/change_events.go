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
	ChangeEventSessionCreated         ChangeEventType = "session_created"
	ChangeEventSessionUpdated         ChangeEventType = "session_updated"
	ChangeEventPRCreated              ChangeEventType = "pr_created"
	ChangeEventPRUpdated              ChangeEventType = "pr_updated"
	ChangeEventPRCheckRecorded        ChangeEventType = "pr_check_recorded"
	ChangeEventPRSessionChanged       ChangeEventType = "pr_session_changed"
	ChangeEventPRReviewThreadAdded    ChangeEventType = "pr_review_thread_added"
	ChangeEventPRReviewThreadResolved ChangeEventType = "pr_review_thread_resolved"
	ChangeEventReviewRunCreated       ChangeEventType = "review_run_created"
	ChangeEventReviewRunUpdated       ChangeEventType = "review_run_updated"
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

// PendingChangeEvent is recorded atomically with a product mutation. Tenant,
// sequence, and creation time are assigned by the storage adapter so callers
// cannot write an event into another tenant or invent replay ordering.
type PendingChangeEvent struct {
	ProjectID string
	SessionID string
	Type      ChangeEventType
	Payload   json.RawMessage
}

// ChangeEventRecorder is the hook product stores call from their current write
// transaction. Implementations must make the product mutation and event record
// commit or roll back together; a pool-backed or post-commit implementation
// does not satisfy this contract.
type ChangeEventRecorder interface {
	RecordChange(context.Context, PendingChangeEvent) error
}

// ChangeEventSource is the durable replay boundary. Hosted implementations
// scope every call to the tenant in ctx; local implementations are inherently
// single tenant.
type ChangeEventSource interface {
	EventsAfter(ctx context.Context, after int64, limit int) ([]ChangeEvent, error)
	LatestSeq(ctx context.Context) (int64, error)
}

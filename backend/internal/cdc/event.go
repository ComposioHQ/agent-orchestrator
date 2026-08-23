// Package cdc is the change-data-capture delivery layer. Change events are
// captured durably by SQLite triggers into the change_log table (see the storage
// migrations); this package POLLS that log and fans new events out, in order, to
// in-process subscribers such as terminal session-state fan-out. Future SSE/event
// endpoints can subscribe here too.
//
// There is no durable outbox/JSONL/janitor machinery: the change_log table IS
// the durable, ordered source of truth, and clients catch up by reading it from
// their own offset (SSE Last-Event-ID). The poller + broadcaster here are only
// the LIVE push on top of that.
package cdc

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// EventType mirrors the event_type values the DB triggers write.
type EventType = ports.ChangeEventType

// Event types, one per row-change the DB triggers emit into change_log.
const (
	EventProjectCreated         = ports.ChangeEventProjectCreated
	EventProjectUpdated         = ports.ChangeEventProjectUpdated
	EventSessionCreated         = ports.ChangeEventSessionCreated
	EventSessionUpdated         = ports.ChangeEventSessionUpdated
	EventPRCreated              = ports.ChangeEventPRCreated
	EventPRUpdated              = ports.ChangeEventPRUpdated
	EventPRCheckRecorded        = ports.ChangeEventPRCheckRecorded
	EventPRSessionChanged       = ports.ChangeEventPRSessionChanged
	EventPRReviewThreadAdded    = ports.ChangeEventPRReviewThreadAdded
	EventPRReviewThreadResolved = ports.ChangeEventPRReviewThreadResolved
	EventPRCommentRecorded      = ports.ChangeEventPRCommentRecorded
	EventPRReviewRecorded       = ports.ChangeEventPRReviewRecorded
	EventReviewRunCreated       = ports.ChangeEventReviewRunCreated
	EventReviewRunUpdated       = ports.ChangeEventReviewRunUpdated
	EventNotificationCreated    = ports.ChangeEventNotificationCreated
	EventNotificationResolved   = ports.ChangeEventNotificationResolved
)

// Event is one CDC change read from change_log. Seq is the monotonic ordering +
// idempotency key (consumers dedup by it). SessionID is empty for project-level
// events. Payload is the trigger-built JSON, kept raw so a typed transport can
// narrow it by Type (the discriminated-union decode lives at the transport edge,
// not here).
type Event = ports.ChangeEvent

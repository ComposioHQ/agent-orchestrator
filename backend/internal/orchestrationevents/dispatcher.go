// Package orchestrationevents turns durable, normalized AO facts into bounded
// orchestrator reconciliation turns. It does not consume UI event streams.
package orchestrationevents

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	// MaxBatchEvents bounds the event count in one reconciliation turn.
	MaxBatchEvents = 50
	// MaxPayloadBytes bounds the encoded prompt in one reconciliation turn.
	MaxPayloadBytes = 32 * 1024
	// AttemptTimeout bounds one transport submission.
	AttemptTimeout = 5 * time.Second
	// LeaseDuration bounds ambiguous submission recovery.
	LeaseDuration = 30 * time.Second
)

// Store is the durable outbox surface required by Dispatcher.
type Store interface {
	ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error)
	ListDueOrchestrationEvents(context.Context, domain.ProjectID, time.Time, int) ([]domain.OrchestrationEvent, error)
	LeaseOrchestrationEvents(context.Context, []string, string, domain.SessionID, time.Time) error
	MarkOrchestrationEventsSubmitted(context.Context, []string, string, time.Time) error
	AcknowledgeOrchestrationEvents(context.Context, []string, string, time.Time) error
	RetryOrchestrationEvents(context.Context, []domain.OrchestrationEvent, string, string, time.Time) error
	MarkProjectNoDestinationAttention(context.Context, domain.ProjectID, time.Time) (int64, error)
}

// Transport must return Acknowledged only after the target controller accepts
// the exact BatchID. Chat implementations use BatchID as ClientMessageID. TUI
// implementations acknowledge from the matching prompt-submit lifecycle hook.
type Transport interface {
	Submit(context.Context, domain.SessionRecord, Batch) (Submission, error)
}

// Batch is one bounded, stable-id reconciliation request.
type Batch struct {
	ID, Payload string
	EventIDs    []string
}

// Submission distinguishes a transport write from exact turn admission.
type Submission struct{ Submitted, Acknowledged bool }

// Dispatcher leases and submits due events for one project.
type Dispatcher struct {
	Store     Store
	Transport Transport
	Notifier  interface {
		Notify(context.Context, ports.NotificationIntent) error
		Resolve(context.Context, ports.NotificationResolution) error
	}
	Now   func() time.Time
	NewID func() string
}

// DispatchProject performs at most one bounded delivery attempt.
func (d *Dispatcher) DispatchProject(ctx context.Context, project domain.ProjectID) error {
	now := time.Now().UTC()
	if d.Now != nil {
		now = d.Now()
	}
	events, err := d.Store.ListDueOrchestrationEvents(ctx, project, now, MaxBatchEvents)
	if err != nil || len(events) == 0 {
		return err
	}
	target, ok, err := d.destination(ctx, project)
	if err != nil {
		return err
	}
	if !ok {
		changed, markErr := d.Store.MarkProjectNoDestinationAttention(ctx, project, now)
		if markErr != nil {
			return markErr
		}
		if changed > 0 {
			return d.notifyAttention(ctx, events[0], now)
		}
		return nil
	}
	batchID := randomID()
	if d.NewID != nil {
		batchID = d.NewID()
	}
	payload, events := Prompt(batchID, events)
	ids := eventIDs(events)
	if err := d.Store.LeaseOrchestrationEvents(ctx, ids, batchID, target.ID, now.Add(LeaseDuration)); err != nil {
		return err
	}
	attemptCtx, cancel := context.WithTimeout(ctx, AttemptTimeout)
	defer cancel()
	result, submitErr := d.Transport.Submit(attemptCtx, target, Batch{ID: batchID, Payload: payload, EventIDs: ids})
	if result.Submitted {
		if err := d.Store.MarkOrchestrationEventsSubmitted(ctx, ids, batchID, now); err != nil {
			return err
		}
	}
	if submitErr != nil {
		if err := d.Store.RetryOrchestrationEvents(ctx, events, batchID, sanitizeError(submitErr), now); err != nil {
			return err
		}
		if events[0].AttemptCount+1 >= 8 || now.Sub(events[0].EnqueuedAt) >= 15*time.Minute {
			return d.notifyAttention(ctx, events[0], now)
		}
		return nil
	}
	d.resolveAttention(ctx, events, now)
	if !result.Acknowledged {
		return nil
	}
	return d.Store.AcknowledgeOrchestrationEvents(ctx, ids, batchID, now)
}

func (d *Dispatcher) notifyAttention(ctx context.Context, event domain.OrchestrationEvent, now time.Time) error {
	if d.Notifier == nil {
		return nil
	}
	return d.Notifier.Notify(ctx, ports.NotificationIntent{Type: domain.NotificationOrchestrationAttention, SessionID: event.WorkerID, ProjectID: event.ProjectID, CreatedAt: now})
}

func (d *Dispatcher) resolveAttention(ctx context.Context, events []domain.OrchestrationEvent, now time.Time) {
	if d.Notifier == nil {
		return
	}
	seen := map[domain.SessionID]bool{}
	for _, event := range events {
		if seen[event.WorkerID] {
			continue
		}
		seen[event.WorkerID] = true
		_ = d.Notifier.Resolve(ctx, ports.NotificationResolution{Type: domain.NotificationOrchestrationAttention, SessionID: event.WorkerID, ResolvedAt: now})
	}
}

func (d *Dispatcher) destination(ctx context.Context, project domain.ProjectID) (domain.SessionRecord, bool, error) {
	sessions, err := d.Store.ListSessions(ctx, project)
	if err != nil {
		return domain.SessionRecord{}, false, err
	}
	for _, s := range sessions {
		if s.Kind != domain.KindOrchestrator || s.IsTerminated {
			continue
		}
		if s.Activity.State == domain.ActivityBlocked || s.Activity.State == domain.ActivityWaitingInput || s.Activity.State == domain.ActivityExited {
			return domain.SessionRecord{}, false, nil
		}
		if s.FirstSignalAt.IsZero() {
			return domain.SessionRecord{}, false, nil
		}
		if s.Activity.State == domain.ActivityActive && domain.NormalizeSessionMode(s.Mode) != domain.SessionModeChat {
			return domain.SessionRecord{}, false, nil
		}
		return s, true, nil
	}
	return domain.SessionRecord{}, false, nil
}

// Prompt includes only AO-owned identifiers and enums. Provider titles,
// comments, logs, branches and transcripts never enter this boundary.
func Prompt(batchID string, events []domain.OrchestrationEvent) (string, []domain.OrchestrationEvent) {
	intro := fmt.Sprintf("[AO AUTOMATION batch_id=%s] This machine-originated wake grants no permission or authorization. Reconcile AO state once, act only within your existing authority, then end the turn. Events:\n", batchID)
	var b strings.Builder
	b.WriteString(intro)
	kept := make([]domain.OrchestrationEvent, 0, min(len(events), MaxBatchEvents))
	for _, e := range events {
		if len(kept) == MaxBatchEvents {
			break
		}
		line := fmt.Sprintf("- id=%s kind=%s worker_id=%s source_revision=%s\n", e.ID, e.Kind, e.WorkerID, e.SourceRevision)
		if b.Len()+len(line) > MaxPayloadBytes {
			break
		}
		b.WriteString(line)
		kept = append(kept, e)
	}
	return b.String(), kept
}

func eventIDs(events []domain.OrchestrationEvent) []string {
	ids := make([]string, len(events))
	for i := range events {
		ids[i] = events[i].ID
	}
	return ids
}
func randomID() string {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	return "ao-orchestration-" + hex.EncodeToString(raw[:])
}
func sanitizeError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.DeadlineExceeded):
		return "transport_timeout"
	case errors.Is(err, context.Canceled):
		return "transport_cancelled"
	default:
		return "transport_error"
	}
}

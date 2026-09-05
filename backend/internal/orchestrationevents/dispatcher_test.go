package orchestrationevents

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type fakeStore struct {
	sessions                          []domain.SessionRecord
	events                            []domain.OrchestrationEvent
	leased, submitted, acked, retried []string
	destination                       domain.SessionID
}

func (f *fakeStore) ListSessions(context.Context, domain.ProjectID) ([]domain.SessionRecord, error) {
	return f.sessions, nil
}
func (f *fakeStore) ListDueOrchestrationEvents(context.Context, domain.ProjectID, time.Time, int) ([]domain.OrchestrationEvent, error) {
	return f.events, nil
}
func (f *fakeStore) LeaseOrchestrationEvents(_ context.Context, ids []string, _ string, d domain.SessionID, _ time.Time) error {
	f.leased = ids
	f.destination = d
	return nil
}
func (f *fakeStore) MarkOrchestrationEventsSubmitted(_ context.Context, ids []string, _ string, _ time.Time) error {
	f.submitted = ids
	return nil
}
func (f *fakeStore) AcknowledgeOrchestrationEvents(_ context.Context, ids []string, _ string, _ time.Time) error {
	f.acked = ids
	return nil
}
func (f *fakeStore) RetryOrchestrationEvents(_ context.Context, e []domain.OrchestrationEvent, _, _ string, _ time.Time) error {
	f.retried = eventIDs(e)
	return nil
}

type fakeTransport struct {
	calls  int
	target domain.SessionID
	batch  Batch
	result Submission
	err    error
}

func (f *fakeTransport) Submit(_ context.Context, s domain.SessionRecord, b Batch) (Submission, error) {
	f.calls++
	f.target = s.ID
	f.batch = b
	return f.result, f.err
}

func TestDispatchResolvesCurrentDestinationAndAcknowledgesAcceptedBatch(t *testing.T) {
	now := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	store := &fakeStore{sessions: []domain.SessionRecord{
		{ID: "old", ProjectID: "p", Kind: domain.KindOrchestrator, IsTerminated: true},
		{ID: "current", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat, Activity: domain.Activity{State: domain.ActivityIdle}, FirstSignalAt: now},
	}, events: []domain.OrchestrationEvent{{ID: "e1", ProjectID: "p", WorkerID: "w", Kind: domain.OrchestrationWorkerTurnSettled, SourceRevision: "r1", EnqueuedAt: now}}}
	transport := &fakeTransport{result: Submission{Submitted: true, Acknowledged: true}}
	d := Dispatcher{Store: store, Transport: transport, Now: func() time.Time { return now }, NewID: func() string { return "batch-1" }}
	if err := d.DispatchProject(context.Background(), "p"); err != nil {
		t.Fatal(err)
	}
	if transport.target != "current" || store.destination != "current" {
		t.Fatalf("destination transport=%q lease=%q", transport.target, store.destination)
	}
	if len(store.acked) != 1 || store.acked[0] != "e1" {
		t.Fatalf("acked=%v", store.acked)
	}
	if !strings.Contains(transport.batch.Payload, "worker_turn_settled") || strings.Contains(transport.batch.Payload, "completed") {
		t.Fatalf("payload=%q", transport.batch.Payload)
	}
}

func TestUnsafeOrMissingDestinationPerformsNoWrite(t *testing.T) {
	states := []domain.ActivityState{domain.ActivityBlocked, domain.ActivityWaitingInput, domain.ActivityExited}
	for _, state := range states {
		t.Run(string(state), func(t *testing.T) {
			now := time.Now()
			store := &fakeStore{sessions: []domain.SessionRecord{{ID: "o", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: state}, FirstSignalAt: now}}, events: []domain.OrchestrationEvent{{ID: "e"}}}
			transport := &fakeTransport{}
			if err := (&Dispatcher{Store: store, Transport: transport}).DispatchProject(context.Background(), "p"); err != nil {
				t.Fatal(err)
			}
			if transport.calls != 0 || len(store.leased) != 0 {
				t.Fatalf("unsafe state wrote: calls=%d leased=%v", transport.calls, store.leased)
			}
		})
	}
}

func TestBusyTUIDefersWhileBusyChatQueues(t *testing.T) {
	now := time.Now()
	event := domain.OrchestrationEvent{ID: "e", ProjectID: "p", WorkerID: "w", Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "r", EnqueuedAt: now}
	for _, tc := range []struct {
		name string
		mode domain.SessionMode
		want int
	}{{"tui", domain.SessionModeTUI, 0}, {"chat", domain.SessionModeChat, 1}} {
		t.Run(tc.name, func(t *testing.T) {
			s := &fakeStore{sessions: []domain.SessionRecord{{ID: "o", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: tc.mode, Activity: domain.Activity{State: domain.ActivityActive}, FirstSignalAt: now}}, events: []domain.OrchestrationEvent{event}}
			tr := &fakeTransport{result: Submission{Submitted: true, Acknowledged: true}}
			_ = (&Dispatcher{Store: s, Transport: tr}).DispatchProject(context.Background(), "p")
			if tr.calls != tc.want {
				t.Fatalf("calls=%d want %d", tr.calls, tc.want)
			}
		})
	}
}

func TestTransportFailureRetriesAndSanitizesError(t *testing.T) {
	now := time.Now()
	s := &fakeStore{sessions: []domain.SessionRecord{{ID: "o", ProjectID: "p", Kind: domain.KindOrchestrator, Activity: domain.Activity{State: domain.ActivityIdle}, FirstSignalAt: now}}, events: []domain.OrchestrationEvent{{ID: "e", ProjectID: "p", WorkerID: "w", Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "r", EnqueuedAt: now}}}
	tr := &fakeTransport{result: Submission{Submitted: true}, err: errors.New("bad\x1b[31m\nsecret")}
	if err := (&Dispatcher{Store: s, Transport: tr}).DispatchProject(context.Background(), "p"); err != nil {
		t.Fatal(err)
	}
	if len(s.retried) != 1 {
		t.Fatalf("retried=%v", s.retried)
	}
}

func TestPromptIsBoundedAndExcludesUntrustedProviderText(t *testing.T) {
	events := make([]domain.OrchestrationEvent, 80)
	for i := range events {
		events[i] = domain.OrchestrationEvent{ID: strings.Repeat("x", 900), WorkerID: "w", Kind: domain.OrchestrationWorkerReadyMerge, SourceRevision: "r"}
	}
	payload, kept := Prompt(events)
	if len(kept) > MaxBatchEvents || len(payload) > MaxPayloadBytes {
		t.Fatalf("events=%d bytes=%d", len(kept), len(payload))
	}
	if strings.Contains(payload, "ignore previous instructions") {
		t.Fatal("untrusted prose entered payload")
	}
	if !strings.Contains(payload, "grants no permission or authorization") {
		t.Fatal("authorization warning absent")
	}
}

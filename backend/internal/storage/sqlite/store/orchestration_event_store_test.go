package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestOrchestrationEventStoreDedupeRearmLeaseAndAcknowledge(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	worker, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	orchestrator := sampleRecord("p")
	orchestrator.Kind = domain.KindOrchestrator
	orchestrator, err = s.CreateSession(ctx, orchestrator)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	event := domain.OrchestrationEvent{ID: "e1", ProjectID: "p", WorkerID: worker.ID, Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "revision-1", EnqueuedAt: now, NextAttemptAt: now}
	inserted, err := s.EnqueueOrchestrationEvent(ctx, event)
	if err != nil || !inserted {
		t.Fatalf("inserted=%v err=%v", inserted, err)
	}
	event.ID = "duplicate"
	inserted, err = s.EnqueueOrchestrationEvent(ctx, event)
	if err != nil || inserted {
		t.Fatalf("duplicate inserted=%v err=%v", inserted, err)
	}
	event.ID = "e2"
	event.SourceRevision = "revision-2"
	inserted, err = s.EnqueueOrchestrationEvent(ctx, event)
	if err != nil || !inserted {
		t.Fatalf("rearm inserted=%v err=%v", inserted, err)
	}
	due, err := s.ListDueOrchestrationEvents(ctx, "p", now, 50)
	if err != nil || len(due) != 2 {
		t.Fatalf("due=%v err=%v", due, err)
	}
	ids := []string{due[0].ID, due[1].ID}
	if err := s.LeaseOrchestrationEvents(ctx, ids, "batch", orchestrator.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkOrchestrationEventsSubmitted(ctx, ids, "batch", now); err != nil {
		t.Fatal(err)
	}
	if err := s.AcknowledgeOrchestrationEvents(ctx, ids, "wrong", now); err == nil {
		t.Fatal("wrong lease token acknowledged")
	}
	if err := s.AcknowledgeOrchestrationEvents(ctx, ids, "batch", now); err != nil {
		t.Fatal(err)
	}
	if due, err = s.ListDueOrchestrationEvents(ctx, "p", now.Add(time.Hour), 50); err != nil || len(due) != 0 {
		t.Fatalf("acknowledged due=%v err=%v", due, err)
	}
}

func TestOrchestrationEventStoreRestartReclaimsExpiredLease(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	w, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	o := sampleRecord("p")
	o.Kind = domain.KindOrchestrator
	o, err = s.CreateSession(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	e := domain.OrchestrationEvent{ID: "e", ProjectID: "p", WorkerID: w.ID, Kind: domain.OrchestrationWorkerTurnSettled, SourceRevision: "r", EnqueuedAt: now, NextAttemptAt: now}
	if ok, err := s.EnqueueOrchestrationEvent(ctx, e); err != nil || !ok {
		t.Fatal(err)
	}
	if err := s.LeaseOrchestrationEvents(ctx, []string{"e"}, "batch", o.ID, now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if count, err := s.ReclaimOrchestrationEventLeases(ctx, now.Add(2*time.Second)); err != nil || count != 1 {
		t.Fatalf("reclaimed=%d err=%v", count, err)
	}
	due, err := s.ListDueOrchestrationEvents(ctx, "p", now.Add(2*time.Second), 50)
	if err != nil || len(due) != 1 {
		t.Fatalf("due=%v err=%v", due, err)
	}
}

func TestOrchestrationEventStoreTUIAcknowledgesOnlyExactDestinationAndBatch(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	w, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	o := sampleRecord("p")
	o.Kind = domain.KindOrchestrator
	o, err = s.CreateSession(ctx, o)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	e := domain.OrchestrationEvent{ID: "e", ProjectID: "p", WorkerID: w.ID, Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "r", EnqueuedAt: now, NextAttemptAt: now}
	if ok, err := s.EnqueueOrchestrationEvent(ctx, e); err != nil || !ok {
		t.Fatal(err)
	}
	if err := s.LeaseOrchestrationEvents(ctx, []string{"e"}, "batch", o.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkOrchestrationEventsSubmitted(ctx, []string{"e"}, "batch", now); err != nil {
		t.Fatal(err)
	}
	if n, err := s.AcknowledgeOrchestrationBatchAccepted(ctx, o.ID, "wrong", now); err != nil || n != 0 {
		t.Fatalf("wrong token n=%d err=%v", n, err)
	}
	if n, err := s.AcknowledgeOrchestrationBatchAccepted(ctx, "other", "batch", now); err != nil || n != 0 {
		t.Fatalf("wrong destination n=%d err=%v", n, err)
	}
	if n, err := s.AcknowledgeOrchestrationBatchAccepted(ctx, o.ID, "batch", now); err != nil || n != 1 {
		t.Fatalf("exact acknowledgement n=%d err=%v", n, err)
	}
}

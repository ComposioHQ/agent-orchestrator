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

func TestOrchestrationSourceStateDedupesAndRearmsSCMTransition(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	w, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	created, err := s.RecordOrchestrationSourceState(ctx, "p", w.ID, domain.OrchestrationWorkerReadyMerge, "https://example.invalid/pr/1", true, now)
	if err != nil || !created {
		t.Fatalf("first created=%v err=%v", created, err)
	}
	for i := 0; i < 100; i++ {
		created, err = s.RecordOrchestrationSourceState(ctx, "p", w.ID, domain.OrchestrationWorkerReadyMerge, "https://example.invalid/pr/1", true, now.Add(time.Duration(i)*time.Second))
		if err != nil || created {
			t.Fatalf("repeat %d created=%v err=%v", i, created, err)
		}
	}
	if created, err = s.RecordOrchestrationSourceState(ctx, "p", w.ID, domain.OrchestrationWorkerReadyMerge, "https://example.invalid/pr/1", false, now.Add(time.Minute)); err != nil || created {
		t.Fatalf("clear created=%v err=%v", created, err)
	}
	if created, err = s.RecordOrchestrationSourceState(ctx, "p", w.ID, domain.OrchestrationWorkerReadyMerge, "https://example.invalid/pr/1", true, now.Add(2*time.Minute)); err != nil || !created {
		t.Fatalf("rearm created=%v err=%v", created, err)
	}
	events, err := s.ListOrchestrationEvents(ctx, "p", 10)
	if err != nil || len(events) != 2 || events[0].SourceRevision == events[1].SourceRevision {
		t.Fatalf("events=%+v err=%v", events, err)
	}
}

func TestActivityAndOutboxCommitRollsBackOnInjectedInsertFailure(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	w, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	before, ok, err := s.GetSession(ctx, w.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	next := before
	now := time.Now().UTC().Truncate(time.Second)
	next.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	next.UpdatedAt = now
	event := domain.OrchestrationEvent{ID: "e", ProjectID: "p", WorkerID: w.ID, Kind: "invalid_kind", SourceRevision: "r", EnqueuedAt: now, NextAttemptAt: now}
	if _, err := s.CommitActivityAndOrchestrationEvent(ctx, next, event); err == nil {
		t.Fatal("invalid event insert succeeded")
	}
	after, ok, err := s.GetSession(ctx, w.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if after.Activity.State != before.Activity.State || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("source fact escaped rollback: before=%+v after=%+v", before.Activity, after.Activity)
	}
}

func TestOrchestrationRetryDeadLettersAndRequiresMatchingProjectForRearm(t *testing.T) {
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
	e := domain.OrchestrationEvent{ID: "e", ProjectID: "p", WorkerID: w.ID, Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "r", EnqueuedAt: now.Add(-16 * time.Minute), NextAttemptAt: now}
	if ok, err := s.EnqueueOrchestrationEvent(ctx, e); err != nil || !ok {
		t.Fatalf("enqueue=%v err=%v", ok, err)
	}
	if err := s.LeaseOrchestrationEvents(ctx, []string{"e"}, "batch", o.ID, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := s.RetryOrchestrationEvents(ctx, []domain.OrchestrationEvent{e}, "batch", "transient secret\nerror", now); err != nil {
		t.Fatal(err)
	}
	events, err := s.ListOrchestrationEvents(ctx, "p", 10)
	if err != nil || len(events) != 1 || events[0].State != domain.OrchestrationDeadLetter || events[0].AttentionRequiredAt.IsZero() {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if changed, err := s.RetryDeadLetterOrchestrationEvent(ctx, "other", "e", now); err != nil || changed {
		t.Fatalf("cross-project changed=%v err=%v", changed, err)
	}
	if changed, err := s.RetryDeadLetterOrchestrationEvent(ctx, "p", "e", now); err != nil || !changed {
		t.Fatalf("matching project changed=%v err=%v", changed, err)
	}
	events, err = s.ListOrchestrationEvents(ctx, "p", 10)
	if err != nil || events[0].State != domain.OrchestrationPending || events[0].AttemptCount != 0 || !events[0].AttentionRequiredAt.IsZero() {
		t.Fatalf("rearmed events=%+v err=%v", events, err)
	}
}

func TestOrchestrationMissingDestinationAttentionAndRetentionAreDurableAndDeduplicated(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p")
	w, err := s.CreateSession(ctx, sampleRecord("p"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	for _, e := range []domain.OrchestrationEvent{
		{ID: "attention", ProjectID: "p", WorkerID: w.ID, Kind: domain.OrchestrationWorkerBlocked, SourceRevision: "a", EnqueuedAt: now.Add(-16 * time.Minute), NextAttemptAt: now},
		{ID: "expired", ProjectID: "p", WorkerID: w.ID, Kind: domain.OrchestrationWorkerTurnSettled, SourceRevision: "b", EnqueuedAt: now.Add(-31 * 24 * time.Hour), NextAttemptAt: now},
	} {
		if ok, err := s.EnqueueOrchestrationEvent(ctx, e); err != nil || !ok {
			t.Fatalf("enqueue %s=%v err=%v", e.ID, ok, err)
		}
	}
	if n, err := s.MarkProjectNoDestinationAttention(ctx, "p", now); err != nil || n != 2 {
		t.Fatalf("first attention=%d err=%v", n, err)
	}
	if n, err := s.MarkProjectNoDestinationAttention(ctx, "p", now.Add(time.Minute)); err != nil || n != 0 {
		t.Fatalf("deduplicated attention=%d err=%v", n, err)
	}
	if n, err := s.MarkOrchestrationRetentionOverflow(ctx, now); err != nil || n != 1 {
		t.Fatalf("retention=%d err=%v", n, err)
	}
	events, err := s.ListOrchestrationEvents(ctx, "p", 10)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]domain.OrchestrationEvent{}
	for _, event := range events {
		byID[event.ID] = event
	}
	if byID["expired"].State != domain.OrchestrationDeadLetter || byID["expired"].LastError != "retention limit exceeded" {
		t.Fatalf("expired=%+v", byID["expired"])
	}
	if byID["attention"].State != domain.OrchestrationPending || byID["attention"].AttemptCount != 0 || byID["attention"].AttentionRequiredAt.IsZero() {
		t.Fatalf("attention=%+v", byID["attention"])
	}
}

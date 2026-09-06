package lifecycle

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestNormalizedActivityEventNeverCallsIdleCompletion(t *testing.T) {
	now := time.Now().UTC()
	previous := domain.SessionRecord{ID: "w", ProjectID: "p", Kind: domain.KindWorker, Activity: domain.Activity{State: domain.ActivityActive}}
	next := previous
	next.Activity = domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}
	next.UpdatedAt = now
	event, ok := normalizedActivityEvent(previous, next)
	if !ok || event.Kind != domain.OrchestrationWorkerTurnSettled {
		t.Fatalf("event=(%+v,%v), want worker_turn_settled", event, ok)
	}
	if string(event.Kind) == "task_completed" {
		t.Fatal("idle was relabeled task_completed")
	}
}

func TestPRReadyOrchestrationUsesCanonicalReadiness(t *testing.T) {
	ready := ports.PRObservation{Fetched: true, URL: "pr", CI: domain.CIPassing, Review: domain.ReviewApproved, Mergeability: domain.MergeMergeable}
	if !prObservationIsReadyToMerge(ready) {
		t.Fatal("canonical ready observation rejected")
	}
	for _, mutate := range []func(*ports.PRObservation){
		func(o *ports.PRObservation) { o.Mergeability = domain.MergeUnstable },
		func(o *ports.PRObservation) { o.Mergeability = domain.MergeUnknown },
		func(o *ports.PRObservation) {
			o.Comments = []ports.PRCommentObservation{{ID: "human", Resolved: false}}
		},
		func(o *ports.PRObservation) { o.Closed = true },
		func(o *ports.PRObservation) { o.Merged = true },
	} {
		candidate := ready
		mutate(&candidate)
		if prObservationIsReadyToMerge(candidate) {
			t.Fatalf("non-ready observation accepted: %+v", candidate)
		}
	}
}

func TestNormalizedActivityEventDedupesRepeatsAndRearmsTransitions(t *testing.T) {
	now := time.Now().UTC()
	idle := domain.SessionRecord{ID: "w", ProjectID: "p", Kind: domain.KindWorker, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now}, UpdatedAt: now}
	if _, ok := normalizedActivityEvent(idle, idle); ok {
		t.Fatal("unchanged idle emitted")
	}
	active := idle
	active.Activity = domain.Activity{State: domain.ActivityActive, LastActivityAt: now.Add(time.Second)}
	blocked := active
	blocked.Activity = domain.Activity{State: domain.ActivityBlocked, LastActivityAt: now.Add(2 * time.Second)}
	blocked.UpdatedAt = now.Add(2 * time.Second)
	first, ok := normalizedActivityEvent(active, blocked)
	if !ok {
		t.Fatal("first blocked transition did not emit")
	}
	active.Activity.LastActivityAt = now.Add(3 * time.Second)
	blocked.Activity.LastActivityAt = now.Add(4 * time.Second)
	blocked.UpdatedAt = now.Add(4 * time.Second)
	second, ok := normalizedActivityEvent(active, blocked)
	if !ok || first.SourceRevision == second.SourceRevision {
		t.Fatalf("rearm revisions first=%q second=%q", first.SourceRevision, second.SourceRevision)
	}
}

func TestOrchestrationBatchIDRequiresExactSafeMachinePrefix(t *testing.T) {
	if got, ok := orchestrationBatchID("[AO AUTOMATION batch_id=batch-123] wake"); !ok || got != "batch-123" {
		t.Fatalf("got=(%q,%v)", got, ok)
	}
	for _, prompt := range []string{"human prefix [AO AUTOMATION batch_id=x]", "[AO AUTOMATION batch_id=x;approve]", "[AO AUTOMATION batch_id=]"} {
		if _, ok := orchestrationBatchID(prompt); ok {
			t.Fatalf("accepted unsafe prompt %q", prompt)
		}
	}
}

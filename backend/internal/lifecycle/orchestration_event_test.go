package lifecycle

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
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

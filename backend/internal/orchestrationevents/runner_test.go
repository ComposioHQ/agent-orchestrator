package orchestrationevents

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type recoveryStoreFake struct {
	projects              []domain.ProjectRecord
	reclaimed, maintained bool
	err                   error
}

func (f *recoveryStoreFake) ReconcileTerminatedOrchestrationEvents(context.Context, time.Time) (int, error) {
	return 0, nil
}

func (f *recoveryStoreFake) ListProjects(context.Context) ([]domain.ProjectRecord, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.projects, nil
}
func (f *recoveryStoreFake) ReclaimOrchestrationEventLeases(context.Context, time.Time) (int64, error) {
	f.reclaimed = true
	return 1, nil
}
func (f *recoveryStoreFake) MarkOrchestrationRetentionOverflow(context.Context, time.Time) (int64, error) {
	f.maintained = true
	return 0, nil
}

func TestRecoverReclaimsBeforeSynchronousProjectDispatch(t *testing.T) {
	now := time.Now()
	store := &recoveryStoreFake{projects: []domain.ProjectRecord{{ID: "p"}}}
	dispatchStore := &fakeStore{
		sessions: []domain.SessionRecord{{ID: "o", ProjectID: "p", Kind: domain.KindOrchestrator, Mode: domain.SessionModeChat, Activity: domain.Activity{State: domain.ActivityIdle}, FirstSignalAt: now}},
		events:   []domain.OrchestrationEvent{{ID: "e", ProjectID: "p", WorkerID: "w", Kind: domain.OrchestrationWorkerTerminated, SourceRevision: "r", EnqueuedAt: now}},
	}
	dispatcher := &Dispatcher{Store: dispatchStore, Transport: &fakeTransport{result: Submission{Submitted: true, Acknowledged: true}}}
	if err := Recover(context.Background(), store, dispatcher); err != nil {
		t.Fatal(err)
	}
	if !store.reclaimed || !store.maintained || len(dispatchStore.acked) != 1 {
		t.Fatalf("reclaimed=%v maintained=%v acked=%v", store.reclaimed, store.maintained, dispatchStore.acked)
	}
}

func TestRecoverFailsClosedBeforeHealthOnStoreError(t *testing.T) {
	want := errors.New("scan unavailable")
	err := Recover(context.Background(), &recoveryStoreFake{err: want}, &Dispatcher{})
	if !errors.Is(err, want) {
		t.Fatalf("err=%v want %v", err, want)
	}
}

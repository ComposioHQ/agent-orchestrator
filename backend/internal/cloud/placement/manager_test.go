package placement

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

type memoryStore struct {
	record      domain.WorkspacePlacement
	createCalls int
	deleteCalls int
	resumeCalls int
}

func (s *memoryStore) CreateWorkspacePlacement(_ context.Context, input domain.CreateWorkspacePlacement) (domain.WorkspacePlacement, bool, error) {
	s.createCalls++
	s.record = domain.WorkspacePlacement{ID: "workspace", State: domain.WorkspacePlacementPending, Intent: domain.WorkspacePlacementProvision, RepositoryURL: input.RepositoryURL}
	return s.record, true, nil
}
func (s *memoryStore) GetWorkspacePlacement(context.Context, string) (domain.WorkspacePlacement, error) {
	return s.record, nil
}
func (s *memoryStore) ListWorkspacePlacements(context.Context, string, int) (domain.WorkspacePlacementPage, error) {
	return domain.WorkspacePlacementPage{Workspaces: []domain.WorkspacePlacement{s.record}}, nil
}
func (s *memoryStore) RequestWorkspacePlacementDelete(context.Context, string, string) (domain.WorkspacePlacement, bool, error) {
	s.deleteCalls++
	s.record.Intent = domain.WorkspacePlacementDelete
	s.record.State = domain.WorkspacePlacementPending
	return s.record, true, nil
}
func (s *memoryStore) RequestWorkspacePlacementResume(context.Context, string, string) (domain.WorkspacePlacement, bool, error) {
	s.resumeCalls++
	s.record.Intent = domain.WorkspacePlacementResume
	s.record.State = domain.WorkspacePlacementPending
	return s.record, true, nil
}

type recordingExecutor struct {
	records []domain.WorkspacePlacement
	err     error
}

func (e *recordingExecutor) Enqueue(_ context.Context, record domain.WorkspacePlacement) error {
	e.records = append(e.records, record)
	return e.err
}

func TestManagerPersistsBeforeEnqueueAndDispatchesEveryIntent(t *testing.T) {
	store := &memoryStore{}
	executor := &recordingExecutor{}
	manager, err := New(store, executor)
	if err != nil {
		t.Fatal(err)
	}
	record, err := manager.Create(context.Background(), domain.CreateWorkspacePlacement{
		RepositoryURL: "https://github.com/acme/app.git", IdempotencyKey: "create-1",
	})
	if err != nil || store.createCalls != 1 || len(executor.records) != 1 || record.Intent != domain.WorkspacePlacementProvision {
		t.Fatalf("create record=%#v err=%v store=%d enqueued=%#v", record, err, store.createCalls, executor.records)
	}
	if _, err := manager.Delete(context.Background(), record.ID, "delete-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Resume(context.Background(), record.ID, "resume-1"); err != nil {
		t.Fatal(err)
	}
	if store.deleteCalls != 1 || store.resumeCalls != 1 || len(executor.records) != 3 ||
		executor.records[1].Intent != domain.WorkspacePlacementDelete || executor.records[2].Intent != domain.WorkspacePlacementResume {
		t.Fatalf("store delete=%d resume=%d enqueued=%#v", store.deleteCalls, store.resumeCalls, executor.records)
	}
}

func TestManagerFailsClosedAfterDurableAcceptanceWithoutExecutor(t *testing.T) {
	store := &memoryStore{}
	manager, err := New(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Create(context.Background(), domain.CreateWorkspacePlacement{
		RepositoryURL: "https://github.com/acme/app.git", IdempotencyKey: "create-1",
	})
	if !errors.Is(err, ErrUnavailable) || store.createCalls != 1 {
		t.Fatalf("err=%v createCalls=%d", err, store.createCalls)
	}
}

func TestManagerRejectsInvalidCreateBeforePersistence(t *testing.T) {
	store := &memoryStore{}
	manager, _ := New(store, &recordingExecutor{})
	_, err := manager.Create(context.Background(), domain.CreateWorkspacePlacement{
		RepositoryURL: "file:///tmp/repo", IdempotencyKey: "create-1",
	})
	if !errors.Is(err, ErrInvalid) || store.createCalls != 0 {
		t.Fatalf("err=%v createCalls=%d", err, store.createCalls)
	}
}

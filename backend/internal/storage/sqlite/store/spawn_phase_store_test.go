package store_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// The checkpoint is the crash-safety line of a spawn, so its guard is part of
// the contract: it publishes workspace facts exactly once, only for a live
// preparing spawn, and never moves a session backwards.

func newPreparingSession(t *testing.T, project string) domain.SessionRecord {
	t.Helper()
	rec := sampleRecord(project)
	rec.SpawnPhase = domain.SpawnPhasePreparing
	rec.Metadata = domain.SessionMetadata{}
	return rec
}

func TestCheckpointSpawnWorkspaceReadyPublishesWorkspaceFacts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p1")
	created, err := s.CreateSession(ctx, newPreparingSession(t, "p1"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	at := time.Now().UTC().Truncate(time.Second)

	ok, err := s.CheckpointSpawnWorkspaceReady(ctx, created.ID, domain.SpawnWorkspaceCheckpoint{
		WorkspacePath:     "/wt/p1-1",
		WorkspaceRepoPath: "/wt/p1-1/repo",
		Branch:            "ao/p1-1/root",
		Prompt:            "ship it",
		Model:             "opus",
	}, at)
	if err != nil {
		t.Fatalf("CheckpointSpawnWorkspaceReady: %v", err)
	}
	if !ok {
		t.Fatal("checkpoint reported no rows for a live preparing spawn")
	}

	got, found, err := s.GetSession(ctx, created.ID)
	if err != nil || !found {
		t.Fatalf("GetSession: %v found=%v", err, found)
	}
	if got.SpawnPhase != domain.SpawnPhaseWorkspaceReady {
		t.Fatalf("spawn phase = %q, want workspace_ready", got.SpawnPhase)
	}
	if got.Metadata.WorkspacePath != "/wt/p1-1" || got.Metadata.WorkspaceRepoPath != "/wt/p1-1/repo" ||
		got.Metadata.Branch != "ao/p1-1/root" || got.Metadata.Prompt != "ship it" || got.Metadata.Model != "opus" {
		t.Fatalf("checkpointed metadata = %+v, want every workspace fact durable", got.Metadata)
	}
}

func TestCheckpointSpawnWorkspaceReadyIsRefusedOutsidePreparing(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p1")
	created, err := s.CreateSession(ctx, newPreparingSession(t, "p1"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	at := time.Now().UTC().Truncate(time.Second)
	checkpoint := domain.SpawnWorkspaceCheckpoint{WorkspacePath: "/wt/a", Branch: "ao/a"}
	if _, err := s.CheckpointSpawnWorkspaceReady(ctx, created.ID, checkpoint, at); err != nil {
		t.Fatalf("first checkpoint: %v", err)
	}

	// A second write — a retry, or a late write from an attempt that was already
	// abandoned — must not replay stale facts over the advanced session.
	ok, err := s.CheckpointSpawnWorkspaceReady(ctx, created.ID, domain.SpawnWorkspaceCheckpoint{
		WorkspacePath: "/wt/stale", Branch: "ao/stale",
	}, at.Add(time.Second))
	if err != nil {
		t.Fatalf("second checkpoint: %v", err)
	}
	if ok {
		t.Fatal("checkpoint applied twice; the preparing guard is not holding")
	}
	got, _, err := s.GetSession(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.Metadata.WorkspacePath != "/wt/a" {
		t.Fatalf("workspace path = %q, want the first checkpoint to stand", got.Metadata.WorkspacePath)
	}
}

func TestPromoteSpawnPhaseRefusesARowWithNoWorkspace(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p1")
	created, err := s.CreateSession(ctx, newPreparingSession(t, "p1"))
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	ok, err := s.PromoteSpawnPhaseWorkspaceReady(ctx, created.ID, time.Now().UTC())
	if err != nil {
		t.Fatalf("PromoteSpawnPhaseWorkspaceReady: %v", err)
	}
	if ok {
		t.Fatal("a seed with no workspace must never be promoted; it would be treated as owning a worktree")
	}
	got, _, err := s.GetSession(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.SpawnPhase != domain.SpawnPhasePreparing {
		t.Fatalf("spawn phase = %q, want preparing", got.SpawnPhase)
	}
}

// Rows written before the column existed describe fully launched sessions. A
// missing or unknown value must never make an established session look
// half-spawned.
func TestSpawnPhaseDefaultsToControllerReady(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "p1")
	rec := sampleRecord("p1")
	rec.SpawnPhase = ""
	created, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	got, _, err := s.GetSession(ctx, created.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got.SpawnPhase != domain.SpawnPhaseControllerReady {
		t.Fatalf("spawn phase = %q, want controller_ready", got.SpawnPhase)
	}
}

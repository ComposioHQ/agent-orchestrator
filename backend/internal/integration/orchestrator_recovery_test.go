package integration

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ageActivity backdates a session's last activity so a dead-runtime probe is
// conclusive (runtimeClearlyDead requires no recent activity).
func ageActivity(t *testing.T, st *stack, id domain.SessionID) domain.SessionRecord {
	t.Helper()
	ctx := context.Background()
	rec, ok, err := st.store.GetSession(ctx, id)
	if err != nil || !ok {
		t.Fatalf("get session %s: ok=%v err=%v", id, ok, err)
	}
	rec.Activity.LastActivityAt = time.Now().Add(-2 * time.Minute)
	if err := st.store.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	return rec
}

// TestDeadOrchestratorRecoverableWithoutProjectDeletion reproduces the #3921
// failure mode: the orchestrator's runtime dies mid-run (OOM kill), the reaper
// reports it dead, and the user then asks for a new orchestrator. Before the
// crash finalizer + spawn-time release existed, the dead orchestrator's
// worktree kept the canonical orchestrator branch checked out and every
// replacement spawn failed — the only recovery was deleting the project.
func TestDeadOrchestratorRecoverableWithoutProjectDeletion(t *testing.T) {
	ctx := context.Background()
	st := newStack(t)
	st.ws.root = t.TempDir()

	sess, _, _, err := st.sm.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatal(err)
	}
	rec := ageActivity(t, st, sess.ID)
	worktree := rec.Metadata.WorkspacePath
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("orchestrator worktree missing before crash: %v", err)
	}

	// The reaper observes the runtime conclusively dead.
	if err := st.lcm.ApplyRuntimeObservation(ctx, sess.ID, ports.RuntimeFacts{
		Runtime:  ports.ProbeDead,
		Workload: ports.ProbeFailed,
		LaunchID: rec.Metadata.RuntimeLaunchID,
	}); err != nil {
		t.Fatal(err)
	}
	rec, _, _ = st.store.GetSession(ctx, sess.ID)
	if !rec.IsTerminated {
		t.Fatalf("dead orchestrator not terminated: %+v", rec)
	}
	// Crash finalization freed the worktree (and with it the canonical branch)
	// and recorded the restore marker.
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("dead orchestrator worktree still on disk: stat err=%v", err)
	}
	rows, err := st.store.ListSessionWorktrees(ctx, sess.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "removed" {
		t.Fatalf("restore marker rows = %+v err=%v, want one removed row", rows, err)
	}

	// The user clicks "new orchestrator": the replacement spawns without
	// touching the project registration.
	replacement, _, _, err := st.sm.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatalf("replacement orchestrator spawn failed: %v", err)
	}
	if replacement.ID == sess.ID || replacement.IsTerminated {
		t.Fatalf("replacement = %+v, want a fresh live orchestrator", replacement)
	}
	// The replacement supersedes the dead orchestrator's restore marker, so the
	// next boot cannot resurrect it onto the replacement's branch.
	rows, err = st.store.ListSessionWorktrees(ctx, sess.ID)
	if err != nil || len(rows) != 0 {
		t.Fatalf("stale restore marker survived replacement: %+v err=%v", rows, err)
	}
}

// TestOrchestratorSpawnReleasesLeftoverWorktree covers the harsher variant:
// the orchestrator died and even its crash-time teardown failed (or predates
// the finalizer), leaving the worktree on disk with the canonical branch
// checked out. Spawning a replacement must reclaim the leftover instead of
// failing forever.
func TestOrchestratorSpawnReleasesLeftoverWorktree(t *testing.T) {
	ctx := context.Background()
	st := newStack(t)
	st.ws.root = t.TempDir()

	sess, _, _, err := st.sm.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatal(err)
	}
	rec, _, _ := st.store.GetSession(ctx, sess.ID)
	worktree := rec.Metadata.WorkspacePath

	// Simulate a death whose teardown never ran: terminated row, worktree intact.
	rec.IsTerminated = true
	rec.Activity = domain.Activity{State: domain.ActivityExited, LastActivityAt: time.Now()}
	if err := st.store.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(worktree); err != nil {
		t.Fatalf("leftover worktree should exist: %v", err)
	}

	replacement, _, _, err := st.sm.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatalf("replacement orchestrator spawn failed: %v", err)
	}
	if replacement.ID == sess.ID || replacement.IsTerminated {
		t.Fatalf("replacement = %+v, want a fresh live orchestrator", replacement)
	}
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("leftover worktree was not reclaimed by the replacement spawn: stat err=%v", err)
	}
}

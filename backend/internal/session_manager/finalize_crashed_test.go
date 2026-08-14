package sessionmanager

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func crashedRecord(id domain.SessionID) domain.SessionRecord {
	return domain.SessionRecord{
		ID:        id,
		ProjectID: "mer",
		Kind:      domain.KindOrchestrator,
		Harness:   domain.HarnessClaudeCode,
		Metadata: domain.SessionMetadata{
			WorkspacePath:   "/ws/" + string(id),
			Branch:          "ao/mer/orchestrator",
			RuntimeHandleID: "h1",
		},
		IsTerminated: true,
		Activity:     domain.Activity{State: domain.ActivityExited},
	}
}

func TestFinalizeCrashedSessionCapturesWorkAndFreesWorktree(t *testing.T) {
	m, st, rt, ws := newManager()
	st.sessions["mer-1"] = crashedRecord("mer-1")
	ws.stashRef = "refs/ao/preserved/mer-1"

	if err := m.FinalizeCrashedSession(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if rt.destroyed != 1 {
		t.Fatalf("runtime destroys = %d, want 1 (reap leaked runtime + orphaned children)", rt.destroyed)
	}
	rows := st.worktrees["mer-1"]
	if len(rows) != 1 || rows[0].PreservedRef != "refs/ao/preserved/mer-1" || rows[0].State != "removed" {
		t.Fatalf("restore marker rows = %+v, want one removed row carrying the preserve ref", rows)
	}
	found := false
	for _, call := range ws.calls {
		if call == "ForceDestroy:mer-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("worktree was not force-destroyed after capture: calls = %v", ws.calls)
	}
}

func TestFinalizeCrashedSessionRestorableAfterwards(t *testing.T) {
	m, st, _, ws := newManager()
	st.sessions["mer-1"] = crashedRecord("mer-1")
	ws.stashRef = "refs/ao/preserved/mer-1"
	if err := m.FinalizeCrashedSession(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}

	// The finalized session restores through the ordinary user-facing path:
	// the worktree is recreated and the preserved work replayed.
	if _, err := m.RestoreWithMode(ctx, "mer-1"); err != nil {
		t.Fatalf("restore after crash finalize: %v", err)
	}
	rec := st.sessions["mer-1"]
	if rec.IsTerminated {
		t.Fatal("session still terminated after restore")
	}
	applied := false
	for _, call := range ws.calls {
		if call == "ApplyPreserved:mer-1" {
			applied = true
		}
	}
	if !applied {
		t.Fatalf("preserved work was not replayed on restore: calls = %v", ws.calls)
	}
	if rows := st.worktrees["mer-1"]; len(rows) != 0 {
		t.Fatalf("restore marker survived a successful restore: %+v", rows)
	}
}

func TestFinalizeCrashedSessionSkipsLiveAndStaleSessions(t *testing.T) {
	m, st, rt, ws := newManager()

	// A live session must never be finalized: only the LCM's terminal decision
	// reaches this path.
	live := crashedRecord("mer-1")
	live.IsTerminated = false
	st.sessions["mer-1"] = live
	if err := m.FinalizeCrashedSession(ctx, "mer-1"); err != nil {
		t.Fatal(err)
	}
	if rt.destroyed != 0 || len(ws.calls) != 0 {
		t.Fatalf("live session was touched: destroys=%d workspace calls=%v", rt.destroyed, ws.calls)
	}

	// An already-gone worktree (stale) is a clean no-op, not an error.
	st.sessions["mer-2"] = crashedRecord("mer-2")
	ws.stashErr = ports.ErrWorkspaceStale
	if err := m.FinalizeCrashedSession(ctx, "mer-2"); err != nil {
		t.Fatalf("stale worktree should finalize cleanly: %v", err)
	}
	if len(st.worktrees["mer-2"]) != 0 {
		t.Fatalf("stale finalize wrote a marker: %+v", st.worktrees["mer-2"])
	}
}

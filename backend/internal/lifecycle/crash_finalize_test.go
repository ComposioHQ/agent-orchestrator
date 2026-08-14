package lifecycle

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeCrashFinalizer struct {
	calls []domain.SessionID
	err   error
	// sawTerminated records whether the durable terminal fact was already
	// committed when the finalizer ran — teardown must never precede it.
	sawTerminated bool
	store         *fakeStore
}

func (f *fakeCrashFinalizer) FinalizeCrashedSession(_ context.Context, id domain.SessionID) error {
	f.calls = append(f.calls, id)
	if f.store != nil {
		f.sawTerminated = f.store.sessions[id].IsTerminated
	}
	return f.err
}

func TestRuntimeObservation_ConfirmedDeathRunsCrashFinalizer(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity.LastActivityAt = time.Now().Add(-2 * time.Minute)
	st.sessions[rec.ID] = rec
	finalizer := &fakeCrashFinalizer{store: st}
	m.SetCrashFinalizer(finalizer)

	if err := m.ApplyRuntimeObservation(ctx, rec.ID, ports.RuntimeFacts{Runtime: ports.ProbeDead, Workload: ports.ProbeFailed}); err != nil {
		t.Fatal(err)
	}
	if len(finalizer.calls) != 1 || finalizer.calls[0] != rec.ID {
		t.Fatalf("crash finalizer calls = %v, want [mer-1]", finalizer.calls)
	}
	if !finalizer.sawTerminated {
		t.Fatal("crash finalizer ran before the terminal fact was durable")
	}

	// A second, idempotent observation of the same dead runtime must not re-run
	// teardown: the terminated row short-circuits the reducer.
	if err := m.ApplyRuntimeObservation(ctx, rec.ID, ports.RuntimeFacts{Runtime: ports.ProbeDead, Workload: ports.ProbeFailed}); err != nil {
		t.Fatal(err)
	}
	if len(finalizer.calls) != 1 {
		t.Fatalf("crash finalizer re-ran on an already-terminated session: calls = %v", finalizer.calls)
	}
}

func TestRuntimeObservation_CrashFinalizerErrorDoesNotBlockTermination(t *testing.T) {
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	m, st, _ := newManager()
	rec := working("mer-1")
	rec.Activity.LastActivityAt = time.Now().Add(-2 * time.Minute)
	st.sessions[rec.ID] = rec
	finalizer := &fakeCrashFinalizer{store: st, err: errors.New("disk full")}
	m.SetCrashFinalizer(finalizer)

	if err := m.ApplyRuntimeObservation(ctx, rec.ID, ports.RuntimeFacts{Runtime: ports.ProbeDead}); err != nil {
		t.Fatal(err)
	}
	if !st.sessions[rec.ID].IsTerminated {
		t.Fatal("finalizer error prevented crash termination")
	}
	if got := logs.String(); !strings.Contains(got, "crashed-session resource finalization failed") || !strings.Contains(got, "disk full") {
		t.Fatalf("finalizer error log = %q", got)
	}
}

func TestRuntimeObservation_AliveRuntimeDoesNotRunCrashFinalizer(t *testing.T) {
	m, st, _ := newManager()
	rec := working("mer-1")
	st.sessions[rec.ID] = rec
	finalizer := &fakeCrashFinalizer{store: st}
	m.SetCrashFinalizer(finalizer)

	if err := m.ApplyRuntimeObservation(ctx, rec.ID, ports.RuntimeFacts{Runtime: ports.ProbeAlive}); err != nil {
		t.Fatal(err)
	}
	if len(finalizer.calls) != 0 {
		t.Fatalf("crash finalizer ran for an alive runtime: calls = %v", finalizer.calls)
	}
}

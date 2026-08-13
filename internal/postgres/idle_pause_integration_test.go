package postgres

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// markRunning promotes the fixture's sandbox to fully running (desired and
// observed), the state PauseIfIdle and RunningSandboxSessions require. A fresh
// fixture starts desired=running, observed=requested — a real provider
// convergence this test skips by writing observed_state directly.
func (f sandboxFixture) markRunning(t *testing.T) {
	t.Helper()
	if err := f.store.withService(context.Background(), func(tx pgx.Tx) error {
		_, err := tx.Exec(
			context.Background(),
			`UPDATE ao_sandboxes SET observed_state = 'running' WHERE session_id = $1`,
			f.sessionID,
		)
		return err
	}); err != nil {
		t.Fatalf("mark fixture sandbox running: %v", err)
	}
}

// backdateLastUserMessage simulates real idle time passing without a test
// sleeping for it.
func (f sandboxFixture) backdateLastUserMessage(t *testing.T, age time.Duration) {
	t.Helper()
	if err := f.store.withOrg(context.Background(), f.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			context.Background(),
			`UPDATE ao_sessions SET last_user_message_at = now() - $2::interval WHERE id = $1`,
			f.sessionID,
			fmt.Sprintf("%d seconds", int(age.Seconds())),
		)
		return err
	}); err != nil {
		t.Fatalf("backdate last user message: %v", err)
	}
}

// finishOpenTurn claims and completes the fixture's one open turn, so it no
// longer counts as active.
func (f sandboxFixture) finishOpenTurn(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, f)
	turn, ok, err := f.store.ClaimWorkerTurn(ctx, f.orgID, f.sessionID, workerID, epoch)
	if err != nil || !ok {
		t.Fatalf("claim open turn: ok = %v, err = %v", ok, err)
	}
	if _, err := f.store.FinishWorkerTurn(
		ctx, f.orgID, f.sessionID, workerID, turn.ID, epoch, turn.Attempt, "completed", "",
	); err != nil {
		t.Fatalf("finish open turn: %v", err)
	}
}

func (f sandboxFixture) desiredState(t *testing.T) string {
	t.Helper()
	var state string
	if err := f.store.withOrg(context.Background(), f.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			context.Background(),
			`SELECT desired_state FROM ao_sandboxes WHERE session_id = $1`,
			f.sessionID,
		).Scan(&state)
	}); err != nil {
		t.Fatalf("read desired state: %v", err)
	}
	return state
}

func TestPauseIfIdleRequiresSilenceAndNoActiveTurn(t *testing.T) {
	fixture := newSandboxFixture(t, "idle-pause")
	ctx := context.Background()
	fixture.markRunning(t)
	const threshold = 15 * time.Minute

	if paused, err := fixture.store.PauseIfIdle(ctx, fixture.orgID, fixture.sessionID, threshold); err != nil || paused {
		t.Fatalf("paused = %v, err = %v, want false: no user message has ever been sent", paused, err)
	}

	if _, err := fixture.store.SendMessage(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, uuid.NewString(), "hello",
	); err != nil {
		t.Fatalf("send message: %v", err)
	}

	if paused, err := fixture.store.PauseIfIdle(ctx, fixture.orgID, fixture.sessionID, threshold); err != nil || paused {
		t.Fatalf("paused = %v, err = %v, want false: just spoke, and its turn is still active", paused, err)
	}

	fixture.backdateLastUserMessage(t, 20*time.Minute)

	if paused, err := fixture.store.PauseIfIdle(ctx, fixture.orgID, fixture.sessionID, threshold); err != nil || paused {
		t.Fatalf("paused = %v, err = %v, want false: idle long enough, but the turn is still active", paused, err)
	}

	fixture.finishOpenTurn(t)

	paused, err := fixture.store.PauseIfIdle(ctx, fixture.orgID, fixture.sessionID, threshold)
	if err != nil || !paused {
		t.Fatalf("paused = %v, err = %v, want true: idle long enough with no active turn", paused, err)
	}
	if state := fixture.desiredState(t); state != domain.SandboxDesiredPaused {
		t.Fatalf("desired_state = %q, want %q", state, domain.SandboxDesiredPaused)
	}

	if paused, err := fixture.store.PauseIfIdle(ctx, fixture.orgID, fixture.sessionID, threshold); err != nil || paused {
		t.Fatalf("paused = %v, err = %v, want false: already paused, nothing left to converge", paused, err)
	}
}

func TestRunningSandboxSessionsListsOnlyFullyRunningSandboxesAcrossOrgs(t *testing.T) {
	running := newSandboxFixture(t, "idle-pause-running")
	idle := newSandboxFixture(t, "idle-pause-not-running")
	running.markRunning(t)
	// idle stays at its default desired=running, observed=requested: not yet
	// converged, so it must not appear in the scan.

	refs, err := running.store.RunningSandboxSessions(context.Background())
	if err != nil {
		t.Fatalf("list running sandbox sessions: %v", err)
	}
	var sawRunning, sawIdle bool
	for _, ref := range refs {
		if ref.OrgID == running.orgID && ref.SessionID == running.sessionID {
			sawRunning = true
		}
		if ref.OrgID == idle.orgID && ref.SessionID == idle.sessionID {
			sawIdle = true
		}
	}
	if !sawRunning {
		t.Error("RunningSandboxSessions did not list the fully-running fixture")
	}
	if sawIdle {
		t.Error("RunningSandboxSessions listed a sandbox that never reached observed_state=running")
	}
}

func TestSendMessageResumesAPausedSandboxAndStampsLastUserMessage(t *testing.T) {
	fixture := newSandboxFixture(t, "idle-pause-resume")
	ctx := context.Background()

	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`UPDATE ao_sandboxes SET desired_state = 'paused' WHERE session_id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatalf("pause fixture sandbox: %v", err)
	}

	if _, err := fixture.store.SendMessage(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, uuid.NewString(), "wake up",
	); err != nil {
		t.Fatalf("send message: %v", err)
	}

	if state := fixture.desiredState(t); state != domain.SandboxDesiredRunning {
		t.Fatalf("desired_state = %q, want %q: a user message must resume a paused sandbox", state, domain.SandboxDesiredRunning)
	}

	var lastUserMessageAt *time.Time
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx,
			`SELECT last_user_message_at FROM ao_sessions WHERE id = $1`,
			fixture.sessionID,
		).Scan(&lastUserMessageAt)
	}); err != nil {
		t.Fatalf("read last_user_message_at: %v", err)
	}
	if lastUserMessageAt == nil || time.Since(*lastUserMessageAt) > time.Minute {
		t.Fatalf("last_user_message_at = %v, want a timestamp from just now", lastUserMessageAt)
	}
}

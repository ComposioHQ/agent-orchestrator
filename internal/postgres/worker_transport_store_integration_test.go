package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/jackc/pgx/v5"
)

func TestWorkerTransportRoutesDurablyAcrossStoresAndFencesEpochs(t *testing.T) {
	fixture := newSandboxFixture(t, "worker-transport")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)

	request, err := fixture.store.CreateWorkspaceRequest(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace.read",
		json.RawMessage(`{"path":"README.md"}`),
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	secondStore, err := Open(ctx, os.Getenv("AO_CLOUD_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer secondStore.Close()
	claimed, ok, err := secondStore.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || claimed.ID != request.ID {
		t.Fatalf("claim = %+v, ok = %v, err = %v", claimed, ok, err)
	}
	if err := secondStore.CompleteWorkerRequest(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		request.ID,
		epoch,
		claimed.Attempt,
		json.RawMessage(`{"path":"README.md","content":"hello","size":5}`),
	); err != nil {
		t.Fatal(err)
	}
	completed, err := fixture.store.GetWorkspaceRequest(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, request.ID,
	)
	if err != nil || completed.Status != "succeeded" {
		t.Fatalf("completed = %+v, err = %v", completed, err)
	}

	reclaimedRequest, err := fixture.store.CreateWorkspaceRequest(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace.read",
		json.RawMessage(`{"path":"README.md"}`),
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	firstAttempt, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, 5*time.Millisecond,
	)
	if err != nil || !ok || firstAttempt.ID != reclaimedRequest.ID {
		t.Fatalf("first attempt = %+v, ok = %v, err = %v", firstAttempt, ok, err)
	}
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_worker_requests
			SET lease_until = now() - interval '1 second'
			WHERE id = $1`,
			reclaimedRequest.ID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	secondAttempt, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || secondAttempt.ID != reclaimedRequest.ID ||
		secondAttempt.Attempt != firstAttempt.Attempt+1 {
		t.Fatalf("second attempt = %+v, ok = %v, err = %v", secondAttempt, ok, err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		reclaimedRequest.ID,
		epoch,
		firstAttempt.Attempt,
		json.RawMessage(`{"path":"README.md","content":"late","size":4}`),
	); !errors.Is(err, ErrTransportExpired) {
		t.Fatalf("late completion error = %v", err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		reclaimedRequest.ID,
		epoch,
		secondAttempt.Attempt,
		json.RawMessage(`{"path":"README.md","content":"current","size":7}`),
	); err != nil {
		t.Fatal(err)
	}

	staleRequest, err := fixture.store.CreateWorkspaceRequest(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace.read",
		json.RawMessage(`{"path":"README.md"}`),
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	staleClaim, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok {
		t.Fatalf("stale request claim ok=%v err=%v", ok, err)
	}
	if _, err := fixture.store.IssueAccessTicket(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		staleRequest.ID,
		epoch,
		staleClaim.Attempt,
		json.RawMessage(`{"path":"README.md","content":"stale","size":5}`),
	); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("stale completion error = %v", err)
	}
}

func TestWorkerTransportEnforcesTenantAuthorization(t *testing.T) {
	first := newSandboxFixture(t, "transport-tenant-first")
	second := newSandboxFixture(t, "transport-tenant-second")
	ctx := context.Background()
	registerTestWorker(t, first)
	request, err := first.store.CreateWorkspaceRequest(
		ctx,
		first.principal,
		first.orgID,
		first.sessionID,
		"workspace.list",
		json.RawMessage(`{"path":"","limit":50}`),
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.store.GetWorkspaceRequest(
		ctx, second.principal, first.orgID, first.sessionID, request.ID,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant request error = %v", err)
	}
	if _, _, err := first.store.IssueTerminalTicket(
		ctx,
		second.principal,
		first.orgID,
		first.sessionID,
		"workspace",
		time.Minute,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant terminal ticket error = %v", err)
	}
	if _, _, err := first.store.ClaimWorkerRequest(
		ctx, first.orgID, second.sessionID, "wrong-worker", 1, time.Minute,
	); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("cross-session worker claim error = %v", err)
	}
}

func TestTerminalTicketAndFramesAreDurableAndEpochFenced(t *testing.T) {
	fixture := newSandboxFixture(t, "terminal-transport")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'trusted', denied_commands = '{}'
			WHERE id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	token, scopes, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	)
	if err != nil || len(scopes) == 0 {
		t.Fatalf("ticket scopes=%v err=%v", scopes, err)
	}
	terminal, err := fixture.store.OpenTerminal(ctx, token, "workspace", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.OpenTerminal(ctx, token, "workspace", time.Minute); !errors.Is(err, ErrInvalidTicket) {
		t.Fatalf("reused terminal ticket error = %v", err)
	}
	openRequest, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || openRequest.Kind != "terminal.open" {
		t.Fatalf("open request=%+v ok=%v err=%v", openRequest, ok, err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		openRequest.ID,
		epoch,
		openRequest.Attempt,
		json.RawMessage(`{"open":true}`),
	); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.QueueTerminalInput(ctx, terminal, "input-one", []byte("pwd\n")); err != nil {
		t.Fatal(err)
	}
	inputRequest, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || inputRequest.Kind != "terminal.input" {
		t.Fatalf("input request=%+v ok=%v err=%v", inputRequest, ok, err)
	}
	if err := fixture.store.QueueTerminalResize(ctx, terminal, 120, 40); err != nil {
		t.Fatal(err)
	}
	resizeRequest, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || resizeRequest.Kind != "terminal.resize" {
		t.Fatalf("resize request=%+v ok=%v err=%v", resizeRequest, ok, err)
	}
	if _, err := fixture.store.AppendTerminalOutput(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		terminal.ID,
		epoch,
		[]byte("/workspace/repository\n"),
	); err != nil {
		t.Fatal(err)
	}
	frames, state, err := fixture.store.ListTerminalOutput(ctx, terminal, 0, 10)
	if err != nil || state != "open" || len(frames) != 1 {
		t.Fatalf("frames=%+v state=%q err=%v", frames, state, err)
	}
	if _, err := fixture.store.IssueAccessTicket(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:connect"},
		time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.AppendTerminalOutput(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		terminal.ID,
		epoch,
		[]byte("stale"),
	); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("stale terminal output error = %v", err)
	}
}

func TestTerminalTicketWakesPausedSandboxAndWaitsForResumedWorker(t *testing.T) {
	fixture := newSandboxFixture(t, "terminal-resume")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)

	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sandboxes
			SET desired_state = 'paused', observed_state = 'stopped',
				reconcile_after = now() + interval '1 day'
			WHERE org_id = $1 AND session_id = $2`,
			fixture.orgID, fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	if _, _, err := fixture.store.IssueTerminalTicket(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, "workspace", time.Minute,
	); !errors.Is(err, ErrWorkerUnavailable) {
		t.Fatalf("paused terminal ticket error = %v, want ErrWorkerUnavailable", err)
	}

	var desiredState string
	var reconcileDue bool
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT desired_state, reconcile_after <= now()
			FROM ao_sandboxes WHERE org_id = $1 AND session_id = $2`,
			fixture.orgID, fixture.sessionID,
		).Scan(&desiredState, &reconcileDue)
	}); err != nil {
		t.Fatal(err)
	}
	if desiredState != "running" || !reconcileDue {
		t.Fatalf("wake intent = %q due=%v, want running and immediately due", desiredState, reconcileDue)
	}

	// The reconciler observes the provider resume before the worker's next
	// heartbeat proves that the snapshotted process is alive again.
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sandboxes SET observed_state = 'bootstrapping'
			WHERE org_id = $1 AND session_id = $2`,
			fixture.orgID, fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, workerID, "test", epoch,
		[]string{"worker.turns", "worker.transport"},
	); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.store.IssueTerminalTicket(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, "workspace", time.Minute,
	); err != nil {
		t.Fatalf("resumed terminal ticket: %v", err)
	}
}

func TestAgentTerminalTicketReservesAnInteractionLease(t *testing.T) {
	fixture := newSandboxFixture(t, "agent-terminal-interaction")
	ctx := context.Background()
	fixture.markRunning(t)
	workerID, epoch := registerTestWorker(t, fixture)
	if err := fixture.store.MarkWorkerSeen(
		ctx, fixture.orgID, fixture.sessionID, workerID, "test", epoch,
		[]string{"worker.turns", "worker.transport"},
	); err != nil {
		t.Fatal(err)
	}

	if _, _, err := fixture.store.IssueTerminalTicket(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, "agent", time.Minute,
	); err != nil {
		t.Fatalf("agent terminal ticket: %v", err)
	}

	var interactive bool
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT interactive_until > now() FROM ao_sandboxes
			WHERE org_id = $1 AND session_id = $2`,
			fixture.orgID, fixture.sessionID,
		).Scan(&interactive)
	}); err != nil {
		t.Fatal(err)
	}
	if !interactive {
		t.Fatal("agent terminal ticket did not reserve an interaction lease")
	}
}

func TestTerminalOpenHasReservedCapacityAndPriority(t *testing.T) {
	fixture := newSandboxFixture(t, "terminal-priority")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'trusted', denied_commands = '{}'
			WHERE id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	for range maxOutstandingWorkspaceRequests {
		if _, err := fixture.store.CreateWorkspaceRequest(
			ctx,
			fixture.principal,
			fixture.orgID,
			fixture.sessionID,
			"workspace.diff",
			json.RawMessage(`{}`),
			time.Minute,
		); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.store.CreateWorkspaceRequest(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace.diff",
		json.RawMessage(`{}`),
		time.Minute,
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("workspace request above reserved capacity error = %v", err)
	}

	token, _, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.OpenTerminal(ctx, token, "workspace", time.Minute); err != nil {
		t.Fatal(err)
	}
	request, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || request.Kind != "terminal.open" {
		t.Fatalf("priority claim = %+v, ok = %v, err = %v", request, ok, err)
	}
}

func TestOpenTerminalIgnoresStaleEpochTerminalCapacity(t *testing.T) {
	fixture := newSandboxFixture(t, "terminal-stale-capacity")
	ctx := context.Background()
	_, staleEpoch := registerTestWorker(t, fixture)
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'trusted', denied_commands = '{}'
			WHERE id = $1`,
			fixture.sessionID,
		)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO ao_terminal_sessions (
				org_id, session_id, worker_epoch, kind, state, expires_at
			) VALUES
				($1, $2, $3, 'agent', 'open', now() + interval '1 hour'),
				($1, $2, $3, 'workspace', 'open', now() + interval '1 hour')`,
			fixture.orgID, fixture.sessionID, staleEpoch,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_, currentEpoch := registerTestWorker(t, fixture)
	if currentEpoch == staleEpoch {
		t.Fatalf("worker epoch did not advance: %d", currentEpoch)
	}
	token, _, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	)
	if err != nil {
		t.Fatalf("issue terminal ticket: %v", err)
	}
	terminal, err := fixture.store.OpenTerminal(ctx, token, "workspace", time.Minute)
	if err != nil {
		t.Fatalf("open terminal with stale epoch rows present: %v", err)
	}
	if terminal.WorkerEpoch != currentEpoch {
		t.Fatalf("terminal epoch = %d, want %d", terminal.WorkerEpoch, currentEpoch)
	}
}

func TestOpenTerminalReplacesSameKindTerminalDuringBrowserRefresh(t *testing.T) {
	fixture := newSandboxFixture(t, "terminal-refresh-replacement")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'trusted', denied_commands = '{}'
			WHERE id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}

	openWorkspace := func() domain.TerminalSession {
		t.Helper()
		token, _, err := fixture.store.IssueTerminalTicket(
			ctx, fixture.principal, fixture.orgID, fixture.sessionID, "workspace", time.Minute,
		)
		if err != nil {
			t.Fatal(err)
		}
		terminal, err := fixture.store.OpenTerminal(ctx, token, "workspace", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		return terminal
	}

	first := openWorkspace()
	request, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || request.Kind != "terminal.open" {
		t.Fatalf("first open request = %+v, ok = %v, err = %v", request, ok, err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, request.ID, epoch,
		request.Attempt, json.RawMessage(`{"open":true}`),
	); err != nil {
		t.Fatal(err)
	}

	second := openWorkspace()
	if first.ID == second.ID {
		t.Fatalf("replacement reused terminal %q", first.ID)
	}
	if err := fixture.store.QueueTerminalInput(ctx, first, "stale", []byte("pwd\n")); !errors.Is(err, ErrWorkerUnavailable) {
		t.Fatalf("stale terminal input error = %v", err)
	}
	closeRequest, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || closeRequest.Kind != "terminal.close" {
		t.Fatalf("replacement close request = %+v, ok = %v, err = %v", closeRequest, ok, err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, closeRequest.ID, epoch,
		closeRequest.Attempt, json.RawMessage(`{"closed":true}`),
	); err != nil {
		t.Fatal(err)
	}
	openRequest, ok, err := fixture.store.ClaimWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute,
	)
	if err != nil || !ok || openRequest.Kind != "terminal.open" {
		t.Fatalf("replacement open request = %+v, ok = %v, err = %v", openRequest, ok, err)
	}
}

func TestWorkerActivitySignalUpdatesSessionActivity(t *testing.T) {
	fixture := newSandboxFixture(t, "worker-activity")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)

	if err := fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness:        "claude-code",
			Event:          "session-start",
			AgentSessionID: "native-session-1",
		},
	); err != nil {
		t.Fatal(err)
	}
	launch, err := fixture.store.WorkerLaunchSpec(
		ctx, fixture.orgID, fixture.sessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if launch.AgentSessionID != "native-session-1" {
		t.Fatalf("launch agent session id = %q", launch.AgentSessionID)
	}

	err = fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness: "claude-code",
			Event:   "user-prompt-submit",
			State:   contract.ActivityActive,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	session, err := fixture.store.GetSession(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.ActivityState != contract.ActivityActive {
		t.Fatalf("activity = %q, want %q", session.ActivityState, contract.ActivityActive)
	}

	err = fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness:   "claude-code",
			Event:     "permission-request",
			State:     contract.ActivityBlocked,
			ToolName:  "Bash",
			ToolUseID: "tool-1",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	err = fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness:   "claude-code",
			Event:     "post-tool-use",
			State:     contract.ActivityActive,
			ToolName:  "Read",
			ToolUseID: "tool-2",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	session, err = fixture.store.GetSession(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.ActivityState != contract.ActivityBlocked {
		t.Fatalf("unrelated tool cleared blocked activity: %q", session.ActivityState)
	}
	if err := fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness:   "claude-code",
			Event:     "post-tool-use",
			State:     contract.ActivityActive,
			ToolName:  "Bash",
			ToolUseID: "tool-1",
		},
	); err != nil {
		t.Fatal(err)
	}

	if err := fixture.store.SetWorkerActivity(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		epoch,
		worker.ActivityEvent{
			Harness: "claude-code",
			Event:   "stop",
			State:   contract.ActivityIdle,
		},
	); err != nil {
		t.Fatal(err)
	}
	session, err = fixture.store.GetSession(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if session.ActivityState != contract.ActivityIdle {
		t.Fatalf("activity = %q, want %q", session.ActivityState, contract.ActivityIdle)
	}
}

func TestReadOnlySessionRejectsWorkspaceWritesAndTerminalInputScope(t *testing.T) {
	fixture := newSandboxFixture(t, "transport-read-only")
	ctx := context.Background()
	registerTestWorker(t, fixture)
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'read-only' WHERE id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.CreateWorkspaceRequest(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace.write",
		json.RawMessage(`{"path":"README.md","content":"blocked"}`),
		time.Minute,
	); !errors.Is(err, ErrWorkspaceReadOnly) {
		t.Fatalf("read-only write error = %v", err)
	}
	_, scopes, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	)
	if err != nil {
		t.Fatalf("read-only terminal ticket error = %v", err)
	}
	if !slices.Equal(scopes, []string{"terminal:read"}) {
		t.Fatalf("read-only terminal scopes = %v, want terminal:read only", scopes)
	}
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions
			SET mode = 'trusted', denied_commands = ARRAY['git push --force:*']
			WHERE id = $1`,
			fixture.sessionID,
		)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, scopes, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	); err != nil {
		t.Fatalf("denied-command terminal ticket error = %v", err)
	} else if !slices.Equal(scopes, []string{"terminal:read"}) {
		t.Fatalf("denied-command terminal scopes = %v, want terminal:read only", scopes)
	}
}

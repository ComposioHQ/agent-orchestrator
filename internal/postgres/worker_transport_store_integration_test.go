package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

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
	if err := fixture.store.QueueTerminalInput(ctx, terminal, []byte("pwd\n")); err != nil {
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
	_, _, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	)
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("read-only terminal ticket error = %v", err)
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
	if _, _, err := fixture.store.IssueTerminalTicket(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		"workspace",
		time.Minute,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("denied-command terminal ticket error = %v", err)
	}
}

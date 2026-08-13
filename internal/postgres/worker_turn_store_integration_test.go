package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestWorkerTurnExecutionIsDurableAndEpochFenced(t *testing.T) {
	fixture := newSandboxFixture(t, "worker-turn")
	ctx := context.Background()

	message, err := fixture.store.SendMessage(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		uuid.NewString(),
		"implement the durable worker",
	)
	if err != nil {
		t.Fatalf("queue turn: %v", err)
	}
	workerID, epoch := registerTestWorker(t, fixture)

	turn, ok, err := fixture.store.ClaimWorkerTurn(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	)
	if err != nil {
		t.Fatalf("claim turn: %v", err)
	}
	if !ok || turn.Prompt != "implement the durable worker" ||
		turn.Attempt != 1 || turn.WorkerEpoch != epoch ||
		turn.UserEventSequence != message.Sequence {
		t.Fatalf("claimed turn = %#v, ok = %v", turn, ok)
	}
	if _, ok, err := fixture.store.ClaimWorkerTurn(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	); err != nil || ok {
		t.Fatalf("duplicate claim ok = %v, error = %v", ok, err)
	}
	if err := fixture.store.RequestTurnCancellation(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, turn.ID,
	); err != nil {
		t.Fatalf("request cancellation: %v", err)
	}
	// A duplicate cancellation request is idempotent.
	if err := fixture.store.RequestTurnCancellation(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, turn.ID,
	); err != nil {
		t.Fatalf("repeat cancellation: %v", err)
	}
	requested, err := fixture.store.WorkerTurnCancellationRequested(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		turn.ID,
		epoch,
		turn.Attempt,
	)
	if err != nil || !requested {
		t.Fatalf("cancellation requested = %v, error = %v", requested, err)
	}
	if err := fixture.store.AppendWorkerTurnOutput(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		turn.ID,
		epoch,
		turn.Attempt,
		"stdout",
		"partial output",
	); err != nil {
		t.Fatalf("append output: %v", err)
	}
	alreadyFinished, err := fixture.store.FinishWorkerTurn(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		turn.ID,
		epoch,
		turn.Attempt,
		"cancelled",
		"",
	)
	if err != nil || alreadyFinished {
		t.Fatalf("finish cancelled already = %v, error = %v", alreadyFinished, err)
	}
	alreadyFinished, err = fixture.store.FinishWorkerTurn(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		turn.ID,
		epoch,
		turn.Attempt,
		"cancelled",
		"",
	)
	if err != nil || !alreadyFinished {
		t.Fatalf("duplicate finish already = %v, error = %v", alreadyFinished, err)
	}

	events, _, err := fixture.store.ListClientEvents(
		ctx, fixture.principal, fixture.orgID, fixture.sessionID, 0, 100,
	)
	if err != nil {
		t.Fatal(err)
	}
	assertEventCount(t, events, "chat.turn_started", 1)
	assertEventCount(t, events, "chat.interrupt_requested", 1)
	assertEventCount(t, events, "chat.assistant_delta", 1)
	assertEventCount(t, events, "chat.turn_interrupted", 1)

	if _, err := fixture.store.SendMessage(
		ctx,
		fixture.principal,
		fixture.orgID,
		fixture.sessionID,
		uuid.NewString(),
		"resume safely",
	); err != nil {
		t.Fatalf("queue replacement turn: %v", err)
	}
	second, ok, err := fixture.store.ClaimWorkerTurn(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	)
	if err != nil || !ok {
		t.Fatalf("claim replacement turn ok = %v, error = %v", ok, err)
	}

	replacementID, replacementEpoch := registerTestWorker(t, fixture)
	reclaimed, ok, err := fixture.store.ClaimWorkerTurn(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		replacementID,
		replacementEpoch,
	)
	if err != nil || !ok {
		t.Fatalf("reclaim turn ok = %v, error = %v", ok, err)
	}
	if reclaimed.ID != second.ID || reclaimed.Attempt != second.Attempt+1 {
		t.Fatalf("reclaimed turn = %#v, previous = %#v", reclaimed, second)
	}
	if _, err := fixture.store.FinishWorkerTurn(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		workerID,
		second.ID,
		epoch,
		second.Attempt,
		"completed",
		"",
	); !errors.Is(err, ErrStaleWorker) {
		t.Fatalf("stale completion error = %v", err)
	}
	if _, err := fixture.store.FinishWorkerTurn(
		ctx,
		fixture.orgID,
		fixture.sessionID,
		replacementID,
		reclaimed.ID,
		replacementEpoch,
		reclaimed.Attempt,
		"completed",
		"",
	); err != nil {
		t.Fatalf("replacement completion: %v", err)
	}
}

func TestWorkerCredentialIsSelectedBySessionHarness(t *testing.T) {
	fixture := newSandboxFixture(t, "worker-credential")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)
	config, _ := json.Marshal(map[string]string{"credentialType": "oauth_token"})
	err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`INSERT INTO ao_provider_connections (
				org_id, provider, label, encrypted_secret, secret_nonce, config,
				validation_state, validated_at
			) VALUES ($1, 'claude-code', 'default', $2, $3, $4, 'valid', now())`,
			fixture.orgID,
			[]byte("encrypted"),
			[]byte("nonce"),
			config,
		)
		return err
	})
	if err != nil {
		t.Fatalf("insert agent credential: %v", err)
	}
	credential, err := fixture.store.WorkerAgentCredential(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	)
	if err != nil {
		t.Fatalf("load worker credential: %v", err)
	}
	if credential.Provider != "claude-code" ||
		credential.CredentialType != "oauth_token" ||
		string(credential.EncryptedSecret) != "encrypted" {
		t.Fatalf("credential = %#v", credential)
	}
}

func TestWorkerCredentialFallsBackToTheSessionCreatorsPersonalConnection(t *testing.T) {
	fixture := newSandboxFixture(t, "personal-credential")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)

	// No org-level connection for this harness exists — only the session
	// creator's own personal one, connected once and meant to work in every
	// org they belong to.
	config, _ := json.Marshal(map[string]string{"credentialType": "oauth_token"})
	if _, err := fixture.store.UpsertUserProviderConnection(
		ctx, fixture.principal, "claude-code", "default",
		[]byte("personal-encrypted"), []byte("personal-nonce"), config,
	); err != nil {
		t.Fatalf("upsert personal connection: %v", err)
	}

	credential, err := fixture.store.WorkerAgentCredential(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	)
	if err != nil {
		t.Fatalf("load worker credential: %v", err)
	}
	if credential.Provider != "claude-code" ||
		credential.CredentialType != "oauth_token" ||
		string(credential.EncryptedSecret) != "personal-encrypted" {
		t.Fatalf("credential = %#v, want the personal fallback", credential)
	}
}

func TestWorkerCredentialPrefersTheOrgConnectionOverAPersonalOne(t *testing.T) {
	fixture := newSandboxFixture(t, "org-over-personal")
	ctx := context.Background()
	workerID, epoch := registerTestWorker(t, fixture)

	config, _ := json.Marshal(map[string]string{"credentialType": "oauth_token"})
	if _, err := fixture.store.UpsertUserProviderConnection(
		ctx, fixture.principal, "claude-code", "default",
		[]byte("personal-encrypted"), []byte("personal-nonce"), config,
	); err != nil {
		t.Fatalf("upsert personal connection: %v", err)
	}
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(
			ctx,
			`INSERT INTO ao_provider_connections (
				org_id, provider, label, encrypted_secret, secret_nonce, config,
				validation_state, validated_at
			) VALUES ($1, 'claude-code', 'default', $2, $3, $4, 'valid', now())`,
			fixture.orgID, []byte("org-encrypted"), []byte("org-nonce"), config,
		)
		return err
	}); err != nil {
		t.Fatalf("insert org connection: %v", err)
	}

	credential, err := fixture.store.WorkerAgentCredential(
		ctx, fixture.orgID, fixture.sessionID, workerID, epoch,
	)
	if err != nil {
		t.Fatalf("load worker credential: %v", err)
	}
	if string(credential.EncryptedSecret) != "org-encrypted" {
		t.Fatalf("credential = %#v, want the org connection to win", credential)
	}
}

func registerTestWorker(t *testing.T, fixture sandboxFixture) (string, int64) {
	t.Helper()
	token, err := fixture.store.IssueAccessTicket(
		context.Background(),
		fixture.orgID,
		fixture.sessionID,
		"worker_bootstrap",
		[]string{"worker:turn:claim"},
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := fixture.store.RedeemWorkerBootstrapTicket(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	workerID := worker.NextWorkerID(fixture.sessionID, ticket.WorkerEpoch)
	if err := fixture.store.RegisterWorkerBootstrap(
		context.Background(),
		fixture.orgID,
		fixture.sessionID,
		workerID,
		"test",
		ticket.WorkerEpoch,
		[]string{"worker.turns"},
	); err != nil {
		t.Fatal(err)
	}
	return workerID, ticket.WorkerEpoch
}

func assertEventCount(t *testing.T, events []domain.ClientEvent, eventType string, want int) {
	t.Helper()
	got := 0
	for _, event := range events {
		if event.Type == eventType {
			got++
		}
	}
	if got != want {
		t.Fatalf("%s event count = %d, want %d", eventType, got, want)
	}
}

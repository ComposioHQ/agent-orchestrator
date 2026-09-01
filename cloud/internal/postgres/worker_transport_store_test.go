package postgres

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
	"github.com/google/uuid"
)

func TestAppendTerminalInputPayloadPreservesOrderedBytes(t *testing.T) {
	original := []byte{'a', 0x03, 0x1b, '[', 'A', 0x00}
	incoming := []byte("界\r")
	payload, err := json.Marshal(map[string]any{
		"terminalId": "terminal-1",
		"data":       original,
	})
	if err != nil {
		t.Fatal(err)
	}

	coalesced, ok := appendTerminalInputPayload(payload, "terminal-1", incoming)
	if !ok {
		t.Fatal("appendTerminalInputPayload() did not coalesce compatible input")
	}
	var command struct {
		TerminalID string `json:"terminalId"`
		Data       []byte `json:"data"`
	}
	if err := json.Unmarshal(coalesced, &command); err != nil {
		t.Fatal(err)
	}
	if command.TerminalID != "terminal-1" {
		t.Fatalf("terminal id = %q, want terminal-1", command.TerminalID)
	}
	want := append(append([]byte(nil), original...), incoming...)
	if !bytes.Equal(command.Data, want) {
		t.Fatalf("coalesced data = %v, want %v", command.Data, want)
	}
}

func TestAppendTerminalInputPayloadKeepsDeliveryBoundaries(t *testing.T) {
	tests := []struct {
		name       string
		terminalID string
		inputID    string
		data       []byte
		incoming   []byte
	}{
		{
			name:       "different terminal",
			terminalID: "terminal-2",
			data:       []byte("a"),
			incoming:   []byte("b"),
		},
		{
			name:       "idempotent input",
			terminalID: "terminal-1",
			inputID:    "input-1",
			data:       []byte("a"),
			incoming:   []byte("b"),
		},
		{
			name:       "empty existing input",
			terminalID: "terminal-1",
			data:       nil,
			incoming:   []byte("b"),
		},
		{
			name:       "empty incoming input",
			terminalID: "terminal-1",
			data:       []byte("a"),
			incoming:   nil,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload, err := json.Marshal(map[string]any{
				"terminalId": "terminal-1",
				"inputId":    test.inputID,
				"data":       test.data,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := appendTerminalInputPayload(payload, test.terminalID, test.incoming); ok {
				t.Fatal("appendTerminalInputPayload() crossed a delivery boundary")
			}
		})
	}
}

func TestAppendTerminalInputPayloadHonorsWorkerFrameLimit(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"terminalId": "terminal-1",
		"data":       []byte(strings.Repeat("a", maxTerminalInputBytes-1)),
	})
	if err != nil {
		t.Fatal(err)
	}

	if _, ok := appendTerminalInputPayload(payload, "terminal-1", []byte("b")); !ok {
		t.Fatal("appendTerminalInputPayload() rejected the exact worker frame limit")
	}
	if _, ok := appendTerminalInputPayload(payload, "terminal-1", []byte("bc")); ok {
		t.Fatal("appendTerminalInputPayload() exceeded the worker frame limit")
	}
}

func TestQueueTerminalInputCoalescesOnlyThePendingTail(t *testing.T) {
	store, terminal, workerID := newTerminalQueueFixture(t)
	ctx := context.Background()

	first := bytes.Repeat([]byte("a"), 100)
	copy(first[1:5], []byte{0x03, 0x1b, '[', 'A'})
	for _, value := range first {
		if err := store.QueueTerminalInput(ctx, terminal, "", []byte{value}); err != nil {
			t.Fatal(err)
		}
	}
	request := claimTerminalRequest(t, store, terminal, workerID, "terminal.input")
	if data := terminalRequestData(t, request); !bytes.Equal(data, first) {
		t.Fatalf("first input = %v, want %v", data, first)
	}
	completeTerminalRequest(t, store, terminal, workerID, request)

	if err := store.QueueTerminalResize(ctx, terminal, 120, 40); err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{[]byte("界"), []byte("\r")} {
		if err := store.QueueTerminalInput(ctx, terminal, "", data); err != nil {
			t.Fatal(err)
		}
	}
	resize := claimTerminalRequest(t, store, terminal, workerID, "terminal.resize")
	completeTerminalRequest(t, store, terminal, workerID, resize)
	request = claimTerminalRequest(t, store, terminal, workerID, "terminal.input")
	if data := terminalRequestData(t, request); !bytes.Equal(data, []byte("界\r")) {
		t.Fatalf("input after resize = %v, want %v", data, []byte("界\r"))
	}
	completeTerminalRequest(t, store, terminal, workerID, request)

	if request, ok, err := store.ClaimWorkerRequest(
		ctx, terminal.OrgID, terminal.SessionID, workerID, terminal.WorkerEpoch, time.Minute,
	); err != nil || ok || request.ID != "" {
		t.Fatalf("extra request = %+v, ok = %v, err = %v", request, ok, err)
	}
}

func newTerminalQueueFixture(
	t *testing.T,
) (*Store, domain.TerminalSession, string) {
	t.Helper()
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)

	unique := strings.ToLower(uuid.NewString()[:8])
	tokenHash := make([]byte, 32)
	if _, err := rand.Read(tokenHash); err != nil {
		t.Fatal(err)
	}
	principal, orgID, err := store.RegisterLocal(ctx, domain.LocalRegistration{
		Email:        "terminal-queue-" + unique + "@example.com",
		DisplayName:  "Terminal queue test",
		PasswordHash: "test-password-hash",
		OrgSlug:      "terminal-queue-" + unique,
		OrgName:      "Terminal queue test",
	}, tokenHash, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateProject(
		ctx, principal, orgID, unique+"-project", domain.CreateProject{
			DisplayName:   "Terminal queue test",
			RepositoryURL: "https://github.com/example/repo.git",
			DefaultBranch: "main",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(
		ctx, principal, orgID, unique+"-session", 100, domain.CreateSession{
			ProjectID:   project.ID,
			Kind:        "worker",
			Harness:     "codex",
			DisplayName: "Terminal queue test",
			Provider:    "nodeops",
			ResourceProfile: json.RawMessage(
				`{"provider":"nodeops","nodeOps":{"defaultShape":"s-4vcpu-8gb","defaultRootFs":"devbox:1"}}`,
			),
			BootstrapContext: json.RawMessage(`{"provider":"nodeops"}`),
			Release:          "test-release",
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	token, err := store.IssueAccessTicket(
		ctx, orgID, session.ID, "worker_bootstrap", []string{"worker:transport"}, time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := store.RedeemWorkerBootstrapTicket(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	workerID := worker.NextWorkerID(session.ID, ticket.WorkerEpoch)
	capabilities := []string{"worker.transport"}
	if err := store.RegisterWorkerBootstrap(
		ctx, orgID, session.ID, workerID, "test", ticket.WorkerEpoch, capabilities,
	); err != nil {
		t.Fatal(err)
	}
	if err := store.MarkWorkerSeen(
		ctx, orgID, session.ID, workerID, "test", ticket.WorkerEpoch, capabilities,
	); err != nil {
		t.Fatal(err)
	}
	terminal, err := store.EnsureWorkerAgentTerminal(
		ctx, orgID, session.ID, workerID, ticket.WorkerEpoch, time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	return store, terminal, workerID
}

func claimTerminalRequest(
	t *testing.T,
	store *Store,
	terminal domain.TerminalSession,
	workerID string,
	kind string,
) domain.WorkerRequest {
	t.Helper()
	request, ok, err := store.ClaimWorkerRequest(
		context.Background(), terminal.OrgID, terminal.SessionID,
		workerID, terminal.WorkerEpoch, time.Minute,
	)
	if err != nil || !ok || request.Kind != kind {
		t.Fatalf("request = %+v, ok = %v, err = %v; want %s", request, ok, err, kind)
	}
	return request
}

func completeTerminalRequest(
	t *testing.T,
	store *Store,
	terminal domain.TerminalSession,
	workerID string,
	request domain.WorkerRequest,
) {
	t.Helper()
	if err := store.CompleteWorkerRequest(
		context.Background(), terminal.OrgID, terminal.SessionID, workerID,
		request.ID, terminal.WorkerEpoch, request.Attempt, json.RawMessage(`{"ok":true}`),
	); err != nil {
		t.Fatal(err)
	}
}

func terminalRequestData(t *testing.T, request domain.WorkerRequest) []byte {
	t.Helper()
	var command worker.TerminalCommand
	raw, err := json.Marshal(request.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &command); err != nil {
		t.Fatal(err)
	}
	return command.Data
}

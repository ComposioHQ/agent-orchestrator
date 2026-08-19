package workertransport

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/workerexec"
)

func TestSupervisorRunsWorkspaceTerminalAndStopsOnCancellation(t *testing.T) {
	control := &recordingControl{
		requests:  make(chan *worker.TransportRequest, 2),
		completed: make(chan string, 2),
		output:    make(chan string, 2),
	}
	ctx, cancel := context.WithCancel(context.Background())
	supervisor := &Supervisor{
		Control: control, Workspace: t.TempDir(), PollInterval: time.Millisecond,
	}
	done := make(chan error, 1)
	go func() { done <- supervisor.Run(ctx) }()

	control.requests <- &worker.TransportRequest{
		ID: "open", Kind: "terminal.open", Attempt: 1,
		Payload: map[string]any{"terminalId": "terminal-1", "kind": "workspace"},
	}
	waitString(t, control.completed, "open")
	control.requests <- &worker.TransportRequest{
		ID: "input", Kind: "terminal.input", Attempt: 1,
		Payload: map[string]any{
			"terminalId": "terminal-1",
			"data":       []byte("printf 'terminal-ready\\n'; exit\n"),
		},
	}
	waitString(t, control.completed, "input")
	waitOutputContaining(t, control.output, "terminal-ready")

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("supervisor did not stop after cancellation")
	}
}

func TestSupervisorForwardsDurableMessagesIntoAgentPTY(t *testing.T) {
	control := &recordingControl{
		requests: make(chan *worker.TransportRequest),
		turns:    make(chan *worker.Turn, 1),
		turnDone: make(chan string, 1),
		output:   make(chan string, 4),
	}
	started := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	supervisor := &Supervisor{
		Control: control, Workspace: t.TempDir(), PollInterval: time.Millisecond,
		AgentTerminalID: "agent-1",
		AgentCommand: workerexec.Command{
			Path: "/bin/sh",
		},
		Started: started,
	}
	done := make(chan error, 1)
	go func() { done <- supervisor.Run(ctx) }()
	if err := <-started; err != nil {
		t.Fatal(err)
	}
	control.turns <- &worker.Turn{
		ID: "turn-1", Attempt: 1, Prompt: "printf 'message-forwarded\\n'",
	}
	waitString(t, control.turnDone, "turn-1")
	waitOutputContaining(t, control.output, "message-forwarded")
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type recordingControl struct {
	requests  chan *worker.TransportRequest
	turns     chan *worker.Turn
	completed chan string
	turnDone  chan string
	output    chan string
	mu        sync.Mutex
	failed    []string
}

func (c *recordingControl) ClaimTurn(ctx context.Context) (*worker.Turn, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case turn := <-c.turns:
		return turn, nil
	default:
		return nil, nil
	}
}

func (c *recordingControl) CompleteTurn(
	_ context.Context,
	id string,
	_ int,
	_ bool,
) error {
	if c.turnDone != nil {
		c.turnDone <- id
	}
	return nil
}

func (c *recordingControl) FailTurn(
	_ context.Context,
	_ string,
	_ int,
	_ string,
) error {
	return nil
}

func (c *recordingControl) ClaimTransport(ctx context.Context) (*worker.TransportRequest, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case request := <-c.requests:
		return request, nil
	default:
		return nil, nil
	}
}

func (c *recordingControl) CompleteTransport(
	_ context.Context,
	id string,
	_ int,
	_ any,
) error {
	c.completed <- id
	return nil
}

func (c *recordingControl) FailTransport(
	_ context.Context,
	id string,
	_ int,
	_, _ string,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.failed = append(c.failed, id)
	return nil
}

func (c *recordingControl) PublishTerminalOutput(
	_ context.Context,
	_ string,
	data []byte,
) error {
	c.output <- string(data)
	return nil
}

func (c *recordingControl) PublishTerminalExit(
	_ context.Context,
	_ string,
	_ int,
) error {
	return nil
}

func waitString(t *testing.T, values <-chan string, expected string) {
	t.Helper()
	select {
	case value := <-values:
		if value != expected {
			t.Fatalf("value = %q, want %q", value, expected)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %q", expected)
	}
}

func waitOutputContaining(t *testing.T, values <-chan string, expected string) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case value := <-values:
			if strings.Contains(value, expected) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for output containing %q", expected)
		}
	}
}

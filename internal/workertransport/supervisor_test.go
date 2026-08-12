package workertransport

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
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
		ID: "open", Kind: "terminal.open",
		Payload: map[string]any{"terminalId": "terminal-1", "kind": "workspace"},
	}
	waitString(t, control.completed, "open")
	control.requests <- &worker.TransportRequest{
		ID: "input", Kind: "terminal.input",
		Payload: map[string]any{
			"terminalId": "terminal-1",
			"data":       []byte("printf 'terminal-ready\\n'; exit\n"),
		},
	}
	waitString(t, control.completed, "input")
	waitString(t, control.output, "terminal-ready\n")

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

type recordingControl struct {
	requests  chan *worker.TransportRequest
	completed chan string
	output    chan string
	mu        sync.Mutex
	failed    []string
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
	_ any,
) error {
	c.completed <- id
	return nil
}

func (c *recordingControl) FailTransport(
	_ context.Context,
	id, _, _ string,
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

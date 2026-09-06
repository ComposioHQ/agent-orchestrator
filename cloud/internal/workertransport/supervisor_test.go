package workertransport

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
)

// fakeControl records the turn lifecycle calls forwardTurn makes.
type fakeControl struct {
	turn        *worker.Turn
	claimCalls  int
	completed   []string
	failed      []string
	failReasons []string
}

func (f *fakeControl) ClaimTransport(context.Context) (*worker.TransportRequest, error) {
	return nil, nil
}

func (f *fakeControl) ClaimTurn(context.Context) (*worker.Turn, error) {
	f.claimCalls++
	turn := f.turn
	f.turn = nil
	return turn, nil
}

func (f *fakeControl) CompleteTurn(_ context.Context, id string, _ int, _ bool) error {
	f.completed = append(f.completed, id)
	return nil
}

func (f *fakeControl) FailTurn(_ context.Context, id string, _ int, reason string) error {
	f.failed = append(f.failed, id)
	f.failReasons = append(f.failReasons, reason)
	return nil
}

func (f *fakeControl) CompleteTransport(context.Context, string, int, any) error { return nil }
func (f *fakeControl) FailTransport(context.Context, string, int, string, string) error {
	return nil
}
func (f *fakeControl) PublishTerminalOutput(context.Context, string, []byte) error { return nil }
func (f *fakeControl) PublishTerminalExit(context.Context, string, int) error      { return nil }

// agentPipe registers a pipe-backed agent terminal on the supervisor and
// returns the read side, so tests observe exactly what forwardTurn types into
// the PTY.
func agentPipe(t *testing.T, s *Supervisor, terminalID string) *os.File {
	t.Helper()
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = read.Close()
		_ = write.Close()
	})
	s.terminals = map[string]*terminalProcess{
		terminalID: {pty: write, cancel: func() {}, cleanup: func() {}},
	}
	return read
}

func TestForwardTurnHeldUntilAgentOutput(t *testing.T) {
	control := &fakeControl{turn: &worker.Turn{ID: "turn-1", Prompt: "go"}}
	s := &Supervisor{Control: control, AgentTerminalID: "agent-1"}

	handled, err := s.forwardTurn(context.Background())
	if err != nil || handled {
		t.Fatalf("turn before any agent output: handled=%v err=%v", handled, err)
	}
	if control.claimCalls != 0 {
		t.Fatalf("claimed a turn before the agent produced output (%d claims)", control.claimCalls)
	}

	// First output alone is not enough: the grace period must elapse too.
	s.agentOutputAt.Store(time.Now().UnixNano())
	handled, err = s.forwardTurn(context.Background())
	if err != nil || handled {
		t.Fatalf("turn inside grace period: handled=%v err=%v", handled, err)
	}
	if control.claimCalls != 0 {
		t.Fatal("claimed a turn inside the readiness grace period")
	}
}

func TestForwardTurnDeliversAfterReadiness(t *testing.T) {
	control := &fakeControl{turn: &worker.Turn{ID: "turn-1", Prompt: "line one\nline two"}}
	s := &Supervisor{Control: control, AgentTerminalID: "agent-1"}
	read := agentPipe(t, s, "agent-1")
	s.agentOutputAt.Store(time.Now().Add(-2 * agentReadyGrace).UnixNano())

	handled, err := s.forwardTurn(context.Background())
	if err != nil || !handled {
		t.Fatalf("ready turn not handled: handled=%v err=%v", handled, err)
	}
	if len(control.completed) != 1 || control.completed[0] != "turn-1" {
		t.Fatalf("turn not completed: %v", control.completed)
	}

	// The Enter is split from the body and follows after promptEnterDelay so
	// the harness registers a submit keypress instead of a paste (issue #2342);
	// read until it arrives.
	injected := ""
	deadline := time.Now().Add(3 * time.Second)
	buffer := make([]byte, 256)
	for !strings.HasSuffix(injected, "\r") && time.Now().Before(deadline) {
		_ = read.SetReadDeadline(time.Now().Add(2 * time.Second))
		n, err := read.Read(buffer)
		if err != nil && !errors.Is(err, io.EOF) {
			t.Fatalf("read injected input: %v", err)
		}
		injected += string(buffer[:n])
	}
	if !strings.HasPrefix(injected, "\x1b[200~") || !strings.HasSuffix(injected, "\x1b[201~\r") {
		t.Fatalf("multi-line prompt not bracketed-paste wrapped: %q", injected)
	}
}

func TestWriteAgentPromptPassesKeystrokesThrough(t *testing.T) {
	s := &Supervisor{Control: &fakeControl{}, AgentTerminalID: "agent-1"}
	read := agentPipe(t, s, "agent-1")
	// A bare Enter keypress (interactive typing) must not be split or delayed.
	start := time.Now()
	if err := s.writeAgentPrompt("agent-1", []byte("\r")); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed >= promptEnterDelay {
		t.Fatalf("single keystroke delayed by %v", elapsed)
	}
	buffer := make([]byte, 8)
	_ = read.SetReadDeadline(time.Now().Add(time.Second))
	n, _ := read.Read(buffer)
	if string(buffer[:n]) != "\r" {
		t.Fatalf("keystroke mangled: %q", string(buffer[:n]))
	}
}

func TestForwardTurnFailsLoudlyWithoutAgentTerminal(t *testing.T) {
	control := &fakeControl{turn: &worker.Turn{ID: "turn-1", Prompt: "go"}}
	s := &Supervisor{Control: control} // no AgentTerminalID: harness unavailable

	handled, err := s.forwardTurn(context.Background())
	if err != nil || !handled {
		t.Fatalf("terminal-less turn not handled: handled=%v err=%v", handled, err)
	}
	if len(control.failed) != 1 || control.failed[0] != "turn-1" {
		t.Fatalf("turn not failed: %v", control.failed)
	}
	if !strings.Contains(control.failReasons[0], "unavailable") {
		t.Fatalf("unexpected failure reason: %q", control.failReasons[0])
	}
}

func TestCopyTerminalOutputArmsReadiness(t *testing.T) {
	s := &Supervisor{Control: &fakeControl{}, AgentTerminalID: "agent-1"}
	s.copyTerminalOutput(context.Background(), "agent-1", strings.NewReader("banner"))
	if s.agentOutputAt.Load() == 0 {
		t.Fatal("agent output did not arm the readiness gate")
	}

	other := &Supervisor{Control: &fakeControl{}, AgentTerminalID: "agent-1"}
	other.copyTerminalOutput(context.Background(), "workspace-1", strings.NewReader("x"))
	if other.agentOutputAt.Load() != 0 {
		t.Fatal("workspace terminal output must not arm the agent readiness gate")
	}
}

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
func (f *fakeControl) PublishTerminalOutput(context.Context, string, []byte) error  { return nil }
func (f *fakeControl) PublishTerminalExit(context.Context, string, int, bool) error { return nil }

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

type supervisorControlStub struct {
	claimTurnCalls int
	turn           *worker.Turn
}

type chatRunnerStub struct{ idle bool }

func (s chatRunnerStub) Run(context.Context) error { return nil }
func (s chatRunnerStub) Idle() bool                { return s.idle }

type blockingChatRunner struct{ started chan struct{} }

func (r blockingChatRunner) Run(ctx context.Context) error {
	close(r.started)
	<-ctx.Done()
	return nil
}

func (s *supervisorControlStub) ClaimTransport(context.Context) (*worker.TransportRequest, error) {
	return nil, nil
}

func (s *supervisorControlStub) ClaimTurn(context.Context) (*worker.Turn, error) {
	s.claimTurnCalls++
	return s.turn, nil
}

func (s *supervisorControlStub) CompleteTurn(context.Context, string, int, bool) error { return nil }
func (s *supervisorControlStub) FailTurn(context.Context, string, int, string) error   { return nil }
func (s *supervisorControlStub) CompleteTransport(context.Context, string, int, any) error {
	return nil
}
func (s *supervisorControlStub) FailTransport(context.Context, string, int, string, string) error {
	return nil
}
func (s *supervisorControlStub) PublishTerminalOutput(context.Context, string, []byte) error {
	return nil
}
func (s *supervisorControlStub) PublishTerminalExit(context.Context, string, int, bool) error {
	return nil
}

func TestForwardTurnLeavesQueueToChatController(t *testing.T) {
	control := &supervisorControlStub{turn: &worker.Turn{ID: "turn-1", Attempt: 1}}
	supervisor := &Supervisor{Control: control}
	supervisor.iface.current = InterfaceChat

	handled, err := supervisor.forwardTurn(context.Background())
	if err != nil {
		t.Fatalf("forward turn: %v", err)
	}
	if handled {
		t.Fatal("expected transport supervisor not to handle turns in Chat mode")
	}
	if control.claimTurnCalls != 0 {
		t.Fatalf("expected Chat controller to own the queue, got %d claims", control.claimTurnCalls)
	}
}

func TestInspectInterfaceDrainsOnlyActiveChatWork(t *testing.T) {
	tests := []struct {
		name string
		idle bool
		want bool
	}{
		{name: "idle chat controller", idle: true, want: true},
		{name: "running chat turn", idle: false, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			supervisor := &Supervisor{ChatRunner: chatRunnerStub{idle: test.idle}}
			supervisor.iface.current = InterfaceChat

			result, err := supervisor.inspectInterface()
			if err != nil {
				t.Fatalf("inspect interface: %v", err)
			}
			inspection := result.(interfaceInspectResult)
			if inspection.Idle != test.want {
				t.Fatalf("idle = %v, want %v", inspection.Idle, test.want)
			}
		})
	}
}

func TestRunRestartsChatControllerForChatSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan error, 1)
	runnerStarted := make(chan struct{})
	supervisor := &Supervisor{
		Control:          &supervisorControlStub{},
		Workspace:        t.TempDir(),
		Started:          started,
		InitialInterface: InterfaceChat,
		ChatRunner:       blockingChatRunner{started: runnerStarted},
		PollInterval:     time.Millisecond,
	}
	done := make(chan error, 1)
	go func() { done <- supervisor.Run(ctx) }()
	if err := <-started; err != nil {
		t.Fatalf("start chat worker: %v", err)
	}
	select {
	case <-runnerStarted:
	case <-time.After(time.Second):
		t.Fatal("chat controller was not started for a Chat session")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("transport supervisor did not stop")
	}
}

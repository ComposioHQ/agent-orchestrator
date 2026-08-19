package workerexec

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
)

type fakeControl struct {
	mu                 sync.Mutex
	outputs            []worker.OutputEvent
	completeCalls      int
	completedCancelled bool
	failures           []string
	cancelRequested    bool
	completeFailures   int
}

func (f *fakeControl) ClaimTurn(context.Context) (*worker.Turn, error) {
	return nil, nil
}

func (f *fakeControl) Credential(context.Context) (worker.CredentialResponse, error) {
	return worker.CredentialResponse{
		Provider: "claude-code", CredentialType: "api_key", Secret: "secret",
	}, nil
}

func (f *fakeControl) PublishOutput(_ context.Context, output worker.OutputEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outputs = append(f.outputs, output)
	return nil
}

func (f *fakeControl) CancellationRequested(context.Context, string, int) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cancelRequested, nil
}

func (f *fakeControl) CompleteTurn(_ context.Context, _ string, _ int, cancelled bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.completeCalls++
	if f.completeFailures > 0 {
		f.completeFailures--
		return errors.New("temporary completion failure")
	}
	f.completedCancelled = cancelled
	return nil
}

func (f *fakeControl) FailTurn(_ context.Context, _ string, _ int, message string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures = append(f.failures, message)
	return nil
}

type fakeBuilder struct{}

func (fakeBuilder) Build(
	context.Context,
	worker.Turn,
	worker.CredentialResponse,
	string,
) (Command, error) {
	return Command{Path: "fake"}, nil
}

type fakeRunner struct {
	run func(context.Context, func(Output) error) error
}

func (r fakeRunner) Run(ctx context.Context, _ Command, emit func(Output) error) error {
	return r.run(ctx, emit)
}

func TestSupervisorStreamsAndRetriesIdempotentCompletion(t *testing.T) {
	control := &fakeControl{completeFailures: 1}
	supervisor := testSupervisor(control, fakeRunner{run: func(
		_ context.Context,
		emit func(Output) error,
	) error {
		return emit(Output{Stream: "stdout", Text: "hello"})
	}})
	err := supervisor.execute(context.Background(), worker.Turn{
		ID: "turn-1", Harness: "claude-code", Attempt: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.completeCalls != 2 || control.completedCancelled {
		t.Fatalf("completion calls = %d, cancelled = %v", control.completeCalls, control.completedCancelled)
	}
	if len(control.outputs) != 1 ||
		control.outputs[0].Attempt != 2 ||
		control.outputs[0].Text != "hello" {
		t.Fatalf("outputs = %#v", control.outputs)
	}
}

func TestSupervisorCancelsRunningHarness(t *testing.T) {
	control := &fakeControl{cancelRequested: true}
	supervisor := testSupervisor(control, fakeRunner{run: func(
		ctx context.Context,
		_ func(Output) error,
	) error {
		<-ctx.Done()
		return ctx.Err()
	}})
	err := supervisor.execute(context.Background(), worker.Turn{
		ID: "turn-2", Harness: "claude-code", Attempt: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	control.mu.Lock()
	defer control.mu.Unlock()
	if !control.completedCancelled {
		t.Fatal("cancelled harness was not completed as interrupted")
	}
}

func TestSupervisorReportsHarnessFailure(t *testing.T) {
	control := &fakeControl{}
	supervisor := testSupervisor(control, fakeRunner{run: func(
		context.Context,
		func(Output) error,
	) error {
		return errors.New("fake binary failed")
	}})
	err := supervisor.execute(context.Background(), worker.Turn{
		ID: "turn-3", Harness: "claude-code", Attempt: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	control.mu.Lock()
	defer control.mu.Unlock()
	if len(control.failures) != 1 || control.failures[0] != "fake binary failed" {
		t.Fatalf("failures = %#v", control.failures)
	}
}

func testSupervisor(control ControlPlane, runner Runner) Supervisor {
	return Supervisor{
		Control:         control,
		Builder:         fakeBuilder{},
		Runner:          runner,
		Workspace:       "/workspace",
		CancelInterval:  time.Millisecond,
		CompletionRetry: time.Millisecond,
	}
}

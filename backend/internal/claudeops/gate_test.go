package claudeops

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGatePublishesExclusiveIntentBeforeReadersDrain(t *testing.T) {
	gate := NewGate()
	releaseShared, err := gate.AcquireShared(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	leaseResult := make(chan ports.ClaudeCodeOperationLease, 1)
	go func() {
		lease, _ := gate.AcquireExclusive(context.Background())
		leaseResult <- lease
	}()
	deadline := time.Now().Add(time.Second)
	for !gate.ExclusivePendingOrHeld() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, err := gate.AcquireShared(context.Background()); !errors.Is(err, ports.ErrClaudeCodeAccountSwitchInProgress) {
		t.Fatalf("late reader error = %v", err)
	}
	releaseShared()
	lease := <-leaseResult
	if lease == nil {
		t.Fatal("exclusive lease was not granted")
	}
	lease.Release()
	if gate.ExclusivePendingOrHeld() {
		t.Fatal("exclusive state remained after release")
	}
}

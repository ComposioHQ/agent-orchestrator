package sessionmanager

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type terminalReadyAgent struct{ fakeAgent }

func (terminalReadyAgent) DetectTerminalActivity(output string) (domain.ActivityState, bool) {
	if output == "ready" {
		return domain.ActivityIdle, true
	}
	return "", false
}

func TestWaitForMessageDeliveryReadyWaitsForTerminalIdleMarker(t *testing.T) {
	st := newFakeStore()
	st.sessions["orch"] = domain.SessionRecord{
		ID:        "orch",
		ProjectID: "ao",
		Kind:      domain.KindOrchestrator,
		Harness:   domain.HarnessCodex,
		Mode:      domain.SessionModeTUI,
		Activity:  domain.Activity{State: domain.ActivityIdle},
		Metadata:  domain.SessionMetadata{RuntimeHandleID: "orch"},
	}
	runtime := &fakeRuntime{outputs: []string{"starting", "ready"}}
	m := New(Deps{Runtime: runtime, Agents: singleAgent{agent: terminalReadyAgent{}}, Store: st})

	if err := m.WaitForMessageDeliveryReady(context.Background(), "orch"); err != nil {
		t.Fatalf("WaitForMessageDeliveryReady: %v", err)
	}
	if runtime.outputCalls < 2 {
		t.Fatalf("terminal output calls = %d, want readiness polling", runtime.outputCalls)
	}
}

func TestWaitForMessageDeliveryReadyHonorsContextWhileTerminalStarts(t *testing.T) {
	st := newFakeStore()
	st.sessions["orch"] = domain.SessionRecord{
		ID:        "orch",
		ProjectID: "ao",
		Kind:      domain.KindOrchestrator,
		Harness:   domain.HarnessCodex,
		Mode:      domain.SessionModeTUI,
		Activity:  domain.Activity{State: domain.ActivityIdle},
		Metadata:  domain.SessionMetadata{RuntimeHandleID: "orch"},
	}
	m := New(Deps{Runtime: &fakeRuntime{outputs: []string{"starting"}}, Agents: singleAgent{agent: terminalReadyAgent{}}, Store: st})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	err := m.WaitForMessageDeliveryReady(ctx, "orch")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("WaitForMessageDeliveryReady error = %v, want context deadline", err)
	}
}

func TestWaitForMessageDeliveryReadyWaitsForFirstHookSignal(t *testing.T) {
	st := newFakeStore()
	st.sessions["cursor-1"] = domain.SessionRecord{
		ID:        "cursor-1",
		ProjectID: "phoenix",
		Harness:   domain.HarnessCursor,
		Mode:      domain.SessionModeTUI,
		Activity:  domain.Activity{State: domain.ActivityIdle},
		Metadata:  domain.SessionMetadata{RuntimeHandleID: "cursor-1"},
	}
	m := New(Deps{Runtime: &fakeRuntime{}, Agents: singleAgent{agent: fakeAgent{}}, Store: st})

	done := make(chan error, 1)
	go func() {
		done <- m.WaitForMessageDeliveryReady(context.Background(), "cursor-1")
	}()

	time.Sleep(30 * time.Millisecond)
	rec := st.sessions["cursor-1"]
	rec.FirstSignalAt = time.Now()
	st.sessions["cursor-1"] = rec

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("WaitForMessageDeliveryReady: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for readiness after first hook signal")
	}
}

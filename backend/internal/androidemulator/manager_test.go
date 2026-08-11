package androidemulator

import (
	"context"
	"os"
	"testing"
	"time"
)

func waitForManagerState(t *testing.T, m *Manager, want State) Status {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last Status
	for time.Now().Before(deadline) {
		last = m.Status()
		if last.State == want {
			return last
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Status().State never reached %q, stuck at %q (error=%q)", want, last.State, last.Error)
	return Status{}
}

func fastBootConfig(mode string, extraEnv ...string) BootConfig {
	return BootConfig{
		Command:           os.Args[0],
		Args:              []string{"-test.run=TestHelperProcess"},
		Env:               append([]string{"AO_WANT_HELPER_PROCESS=1", "AO_HELPER_MODE=" + mode}, extraEnv...),
		ReadyCheck:        func(context.Context) (bool, error) { return true, nil },
		ReadyPollInterval: time.Millisecond,
		ReadyTimeout:      2 * time.Second,
		RestartBackoff:    []time.Duration{0, 0},
	}
}

func TestManagerStartTransitionsToRunning(t *testing.T) {
	m := NewManager()
	if err := m.Start(context.Background(), fastBootConfig("sleep")); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForManagerState(t, m, StateRunning)
	_ = m.Stop(context.Background())
}

func TestManagerStartRecordsAccelStatusWithoutBlocking(t *testing.T) {
	cfg := fastBootConfig("sleep")
	cfg.AccelCheck = func(context.Context) (AccelStatus, error) {
		return AccelStatus{Available: false, Detail: "no hypervisor found"}, nil
	}
	m := NewManager()
	if err := m.Start(context.Background(), cfg); err != nil {
		t.Fatalf("Start: %v, want no error even when acceleration is unavailable (warn, don't block)", err)
	}
	status := waitForManagerState(t, m, StateRunning)
	if status.AccelAvailable {
		t.Error("AccelAvailable = true, want false")
	}
	if status.AccelDetail != "no hypervisor found" {
		t.Errorf("AccelDetail = %q, want %q", status.AccelDetail, "no hypervisor found")
	}
	_ = m.Stop(context.Background())
}

func TestManagerRejectsConcurrentStart(t *testing.T) {
	m := NewManager()
	if err := m.Start(context.Background(), fastBootConfig("sleep")); err != nil {
		t.Fatalf("first Start: %v", err)
	}
	waitForManagerState(t, m, StateRunning)

	if err := m.Start(context.Background(), fastBootConfig("sleep")); err == nil {
		t.Error("second Start while running: want an error, got nil")
	}
	_ = m.Stop(context.Background())
}

func TestManagerUnexpectedExitTriggersAutoRestart(t *testing.T) {
	m := NewManager()
	if err := m.Start(context.Background(), fastBootConfig("crash-once-then-sleep", "AO_CRASH_MARKER="+t.TempDir()+"/marker")); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForManagerState(t, m, StateRunning)
	// The helper process exits nonzero on its first run; Manager should
	// detect the crash and auto-restart, landing back on Running rather than
	// staying stuck Crashed.
	final := waitForManagerState(t, m, StateRunning)
	if final.Error != "" {
		t.Errorf("Error = %q after successful auto-restart, want empty", final.Error)
	}
	_ = m.Stop(context.Background())
}

func TestManagerStaysCrashedAfterExhaustingRestartBudget(t *testing.T) {
	cfg := fastBootConfig("exit-nonzero")
	cfg.RestartBackoff = []time.Duration{0} // exactly one retry budgeted
	m := NewManager()
	if err := m.Start(context.Background(), cfg); err == nil {
		t.Log("first Start returned nil (process exits before ready-check settles); proceeding to observe crash state")
	}
	waitForManagerState(t, m, StateCrashed)
	// Give the one budgeted restart attempt a moment to also fail and land
	// back on Crashed, then confirm it doesn't quietly recover to Running.
	time.Sleep(200 * time.Millisecond)
	if got := m.Status().State; got != StateCrashed {
		t.Errorf("State = %q after exhausting restart budget, want %q", got, StateCrashed)
	}
}

func TestManagerStopDoesNotTriggerAutoRestart(t *testing.T) {
	m := NewManager()
	if err := m.Start(context.Background(), fastBootConfig("sleep")); err != nil {
		t.Fatalf("Start: %v", err)
	}
	waitForManagerState(t, m, StateRunning)

	if err := m.Stop(context.Background()); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if got := m.Status().State; got != StateUninitialized {
		t.Fatalf("State after Stop = %q, want %q", got, StateUninitialized)
	}
	// If Stop's Kill were misclassified as an unexpected crash, the
	// supervisor would auto-restart it back to Running/Booting; give that a
	// beat to (not) happen.
	time.Sleep(200 * time.Millisecond)
	if got := m.Status().State; got != StateUninitialized {
		t.Errorf("State %s after Stop, want it to stay %q (no auto-restart after an intentional stop)", got, StateUninitialized)
	}
}

func TestManagerStopOnNeverStartedIsANoOp(t *testing.T) {
	m := NewManager()
	if err := m.Stop(context.Background()); err != nil {
		t.Errorf("Stop on a never-started manager: %v, want nil", err)
	}
}

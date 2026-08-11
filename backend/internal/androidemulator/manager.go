package androidemulator

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// State is the lifecycle state of the single, shared, daemon-level emulator
// Manager supervises.
type State string

const (
	StateUninitialized State = "uninitialized"
	StateBooting       State = "booting"
	StateRunning       State = "running"
	StateCrashed       State = "crashed"
	StateStopping      State = "stopping"
)

// Status is a point-in-time snapshot of Manager's state.
type Status struct {
	State State
	Error string
	Logs  []string
	// AccelAvailable/AccelDetail reflect the most recent virtualization
	// preflight check. Unavailable acceleration is surfaced as a warning,
	// not a reason to refuse to boot -- degraded (software-rendered) startup
	// is still allowed, per the plan's explicit "warn, don't hard-block"
	// decision.
	AccelAvailable bool
	AccelDetail    string
}

// BootConfig describes how to boot and supervise the emulator.
type BootConfig struct {
	Command string
	Args    []string
	Env     []string

	// AccelCheck, if set, runs once at the start of Start and its result is
	// exposed via Status; it never blocks booting.
	AccelCheck func(ctx context.Context) (AccelStatus, error)

	// ReadyCheck, if set, is polled at ReadyPollInterval until it returns
	// true or ReadyTimeout elapses. A nil ReadyCheck means "ready
	// immediately" (useful for tests; production wiring should always set
	// one, e.g. ADB boot_completed).
	ReadyCheck        func(ctx context.Context) (bool, error)
	ReadyPollInterval time.Duration
	ReadyTimeout      time.Duration

	// RestartBackoff is the delay before each successive auto-restart
	// attempt after an unexpected process exit. Its length caps the number
	// of auto-restarts; once exhausted, Manager stays Crashed until an
	// explicit Start.
	RestartBackoff []time.Duration
}

// Manager supervises the lifecycle of AO's single, persistent, shared
// emulator process: boot, health/ready-check, crash detection with
// auto-restart (bounded by RestartBackoff), and intentional stop.
type Manager struct {
	mu             sync.Mutex
	state          State
	lastErr        string
	accel          AccelStatus
	proc           *Process
	cfg            BootConfig
	stopping       bool
	restartAttempt int
}

// NewManager builds an idle Manager. Nothing is spawned until Start is
// called.
func NewManager() *Manager {
	return &Manager{state: StateUninitialized}
}

// Status returns the current lifecycle state and recent logs.
func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := Status{
		State:          m.state,
		Error:          m.lastErr,
		AccelAvailable: m.accel.Available,
		AccelDetail:    m.accel.Detail,
	}
	if m.proc != nil {
		s.Logs = m.proc.Logs(50)
	}
	return s
}

// Start boots the emulator. It returns once the process is spawned and
// either becomes ready or fails to; a background goroutine then supervises
// it for the rest of its life (crash detection + auto-restart).
func (m *Manager) Start(ctx context.Context, cfg BootConfig) error {
	m.mu.Lock()
	if m.state == StateBooting || m.state == StateRunning {
		state := m.state
		m.mu.Unlock()
		return fmt.Errorf("androidemulator: already %s", state)
	}
	m.cfg = cfg
	m.stopping = false
	m.restartAttempt = 0
	m.state = StateBooting
	m.mu.Unlock()

	if cfg.AccelCheck != nil {
		accel, _ := cfg.AccelCheck(ctx)
		m.mu.Lock()
		m.accel = accel
		m.mu.Unlock()
	}

	return m.bootOnce(ctx)
}

// bootOnce spawns the process once (used both by Start and by the
// auto-restart path) and starts the exit-watcher goroutine on success.
func (m *Manager) bootOnce(ctx context.Context) error {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	proc, err := Spawn(SpawnConfig{Ctx: ctx, Command: cfg.Command, Args: cfg.Args, Env: cfg.Env})
	if err != nil {
		m.mu.Lock()
		m.state = StateCrashed
		m.lastErr = err.Error()
		m.mu.Unlock()
		return err
	}

	m.mu.Lock()
	m.proc = proc
	m.mu.Unlock()

	if !waitReady(ctx, cfg) {
		_ = proc.Kill()
		m.mu.Lock()
		m.state = StateCrashed
		m.lastErr = "emulator did not become ready in time"
		m.mu.Unlock()
		return fmt.Errorf("androidemulator: emulator did not become ready in time")
	}

	m.mu.Lock()
	m.state = StateRunning
	m.lastErr = ""
	m.mu.Unlock()

	go m.watchExit(proc)
	return nil
}

func waitReady(ctx context.Context, cfg BootConfig) bool {
	if cfg.ReadyCheck == nil {
		return true
	}
	deadline := time.Now().Add(cfg.ReadyTimeout)
	for {
		ok, _ := cfg.ReadyCheck(ctx)
		if ok {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(cfg.ReadyPollInterval)
	}
}

// watchExit blocks until proc exits, then either leaves the crash for an
// intentional Stop to have already handled, or treats it as unexpected and
// attempts a bounded auto-restart.
func (m *Manager) watchExit(proc *Process) {
	_ = proc.Wait()

	m.mu.Lock()
	if m.stopping || m.proc != proc {
		// Either Stop already handled this, or proc is a stale process we've
		// since replaced -- either way, this watcher has nothing to do.
		m.mu.Unlock()
		return
	}
	m.state = StateCrashed
	m.lastErr = "emulator process exited unexpectedly"
	attempt := m.restartAttempt
	backoff := m.cfg.RestartBackoff
	m.mu.Unlock()

	if attempt >= len(backoff) {
		return // restart budget exhausted; stay Crashed until an explicit Start
	}
	time.Sleep(backoff[attempt])

	m.mu.Lock()
	if m.stopping {
		m.mu.Unlock()
		return
	}
	m.restartAttempt++
	m.state = StateBooting
	m.mu.Unlock()

	_ = m.bootOnce(context.Background())
}

// Stop kills the running emulator (if any) and returns Manager to
// Uninitialized, ready for a future Start. A no-op if nothing is running.
func (m *Manager) Stop(ctx context.Context) error {
	m.mu.Lock()
	if m.state == StateUninitialized {
		m.mu.Unlock()
		return nil
	}
	m.stopping = true
	m.state = StateStopping
	proc := m.proc
	m.mu.Unlock()

	if proc != nil {
		_ = proc.Kill()
		_ = proc.Wait()
	}

	m.mu.Lock()
	m.state = StateUninitialized
	m.lastErr = ""
	m.proc = nil
	m.mu.Unlock()
	return nil
}

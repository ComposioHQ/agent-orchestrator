package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Phase is the coarse position of the sandbox's bring-up. The values are
// published on an unauthenticated /readyz, so they are workload states and
// never carry an identifier, a path, or a credential.
type Phase string

const (
	// PhaseStarting means nothing has been launched yet.
	PhaseStarting Phase = "starting"
	// PhaseDaemon means the AO daemon is up but has not answered /readyz.
	PhaseDaemon Phase = "starting-daemon"
	// PhaseHarness means the daemon is ready and the agent harness is starting.
	PhaseHarness Phase = "starting-harness"
	// PhaseReady means every declared step is up and its probe passed.
	PhaseReady Phase = "ready"
	// PhaseFailed means a step failed to start, failed its probe, or exited.
	PhaseFailed Phase = "failed"
	// PhaseStopping means the sandbox is shutting down.
	PhaseStopping Phase = "stopping"
)

// Step is one supervised process.
type Step struct {
	// Name appears in logs and in the failure reason. It must be a workload
	// name ("daemon", "harness"), not a path: the reason reaches /readyz.
	Name string
	// Argv is the command. Secrets never go here — see Supervisor.Start.
	Argv []string
	// Env is merged over the inherited environment. This is where secrets go.
	Env map[string]string
	// Dir is the working directory; empty inherits.
	Dir string
	// Phase is what the sandbox reports while this step is coming up.
	Phase Phase
	// ReadyURL, when set, is polled until it answers 2xx before the next step
	// starts. Empty means the step is considered ready as soon as it is spawned.
	ReadyURL string
	// ReadyTimeout bounds that poll. Zero uses defaultReadyTimeout.
	ReadyTimeout time.Duration
}

const (
	defaultReadyTimeout = 90 * time.Second
	readyPollInterval   = 250 * time.Millisecond
	// stopGrace is how long a step gets to exit on SIGTERM before SIGKILL.
	stopGrace = 5 * time.Second
)

// Probe is the readiness check muxd polls, satisfied by Supervisor.
type Probe interface {
	Ready() (phase string, ready bool, reason string)
}

// Reporter publishes the sandbox's state to the control plane. The HTTP
// implementation lives in report.go; the port is here so the supervisor tests
// with a fake and so a sandbox brought up by hand can run without one.
type Reporter interface {
	Report(ctx context.Context, phase Phase, reason string) error
}

// Supervisor starts the sandbox's steps in order and tracks the phase.
type Supervisor struct {
	steps    []Step
	reporter Reporter
	log      *slog.Logger
	secrets  []string
	// strip names environment variables the children must not inherit.
	strip []string
	// probe is the readiness poll, injectable so tests do not need a listener.
	probe func(ctx context.Context, url string) error
	// heartbeat is how often a ready sandbox re-reports. Zero disables it.
	heartbeat time.Duration

	mu      sync.RWMutex
	phase   Phase
	reason  string
	running []*exec.Cmd
}

// Options configures a Supervisor.
type Options struct {
	Steps    []Step
	Reporter Reporter
	Logger   *slog.Logger
	// Secrets are the values that must never appear in a log line. Every child
	// process's stderr passes through Redact with this list.
	Secrets []string
	// StripEnv names variables to remove from the environment children
	// inherit. The sandbox runtime's own ticket-signing key belongs here: it
	// is this process's secret, and an agent that inherited it could mint
	// tickets for the sandbox it is running in.
	StripEnv []string
	// Probe overrides the readiness poll (tests).
	Probe func(ctx context.Context, url string) error
	// Heartbeat is how often a ready sandbox re-reports its state. Zero
	// disables check-ins.
	Heartbeat time.Duration
}

// NewSupervisor builds a supervisor over an ordered list of steps.
func NewSupervisor(opts Options) (*Supervisor, error) {
	if len(opts.Steps) == 0 {
		return nil, errors.New("bootstrap: at least one step is required")
	}
	for _, step := range opts.Steps {
		if strings.TrimSpace(step.Name) == "" {
			return nil, errors.New("bootstrap: every step needs a name")
		}
		if len(step.Argv) == 0 {
			return nil, fmt.Errorf("bootstrap: step %q has no command", step.Name)
		}
		if err := guardArgv(step); err != nil {
			return nil, err
		}
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	probe := opts.Probe
	if probe == nil {
		probe = httpReady
	}
	return &Supervisor{
		steps:     opts.Steps,
		reporter:  opts.Reporter,
		log:       log,
		secrets:   opts.Secrets,
		strip:     opts.StripEnv,
		probe:     probe,
		heartbeat: opts.Heartbeat,
		phase:     PhaseStarting,
	}, nil
}

// guardArgv re-applies the compute plane's no-secrets-in-argv rule at the point
// the process is actually spawned.
//
// runtime.CreateRequest.Validate already enforces it for the sandbox
// entrypoint, but that check runs in the control plane and covers only the
// entrypoint. Steps assembled here — the harness in particular — are a second
// place a credential could reach a command line, and /proc/*/cmdline inside the
// sandbox is readable by the tenant's own agent.
func guardArgv(step Step) error {
	for name, value := range step.Env {
		if len(value) < minimumRedactedLength {
			continue
		}
		for _, arg := range step.Argv {
			if strings.Contains(arg, value) {
				return fmt.Errorf("bootstrap: step %q puts the value of %s on its command line; pass it through the environment", step.Name, name)
			}
		}
	}
	return nil
}

// Ready satisfies Probe (and muxd.Probe).
func (s *Supervisor) Ready() (string, bool, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return string(s.phase), s.phase == PhaseReady, s.reason
}

// Phase returns the current phase.
func (s *Supervisor) Phase() Phase {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.phase
}

// Start brings every step up in order and reports each phase transition. It
// returns once the sandbox is ready, or with the error that stopped it.
//
// ctx scopes the STARTUP, not the sandbox: the children outlive it and are torn
// down by Stop. Wiring the children to ctx instead would kill the daemon the
// moment startup finished.
func (s *Supervisor) Start(ctx context.Context) error {
	for _, step := range s.steps {
		s.setPhase(ctx, step.Phase, "")
		cmd, err := s.spawn(step)
		if err != nil {
			return s.fail(ctx, fmt.Errorf("start %s: %w", step.Name, err))
		}
		s.mu.Lock()
		s.running = append(s.running, cmd)
		s.mu.Unlock()
		go s.watch(step, cmd)

		if step.ReadyURL == "" {
			continue
		}
		timeout := step.ReadyTimeout
		if timeout <= 0 {
			timeout = defaultReadyTimeout
		}
		if err := s.waitReady(ctx, step, timeout); err != nil {
			return s.fail(ctx, err)
		}
		s.log.Info("Sandbox step is ready", "step", step.Name)
	}
	s.setPhase(ctx, PhaseReady, "")
	return nil
}

// spawn starts one step. Secrets reach the child through its environment and
// nowhere else, and its output is redacted on the way to the log.
func (s *Supervisor) spawn(step Step) (*exec.Cmd, error) {
	cmd := exec.Command(step.Argv[0], step.Argv[1:]...) //nolint:gosec // the argv is deployment configuration, not user input
	cmd.Dir = step.Dir
	cmd.Env = mergeEnv(stripEnv(os.Environ(), s.strip), step.Env)
	cmd.Stdout = &redactingWriter{log: s.log, step: step.Name, stream: "stdout", secrets: s.secrets}
	cmd.Stderr = &redactingWriter{log: s.log, step: step.Name, stream: "stderr", secrets: s.secrets}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s.log.Info("Sandbox step started", "step", step.Name, "pid", cmd.Process.Pid)
	return cmd, nil
}

// watch turns a step's exit into a failed sandbox. There is no restart; see the
// package doc.
func (s *Supervisor) watch(step Step, cmd *exec.Cmd) {
	err := cmd.Wait()
	s.mu.RLock()
	stopping := s.phase == PhaseStopping
	s.mu.RUnlock()
	if stopping {
		return
	}
	reason := step.Name + " exited"
	if err != nil {
		reason = step.Name + " exited: " + Redact(err.Error(), s.secrets...)
	}
	s.log.Error("Sandbox step exited", "step", step.Name, "reason", reason)
	s.setPhase(context.Background(), PhaseFailed, reason)
}

// waitReady polls a step's readiness endpoint until it answers or time runs out.
func (s *Supervisor) waitReady(ctx context.Context, step Step, timeout time.Duration) error {
	deadline, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(readyPollInterval)
	defer ticker.Stop()
	var last error
	for {
		if err := s.probe(deadline, step.ReadyURL); err == nil {
			return nil
		} else {
			last = err
		}
		select {
		case <-deadline.Done():
			// The reason reaches /readyz, so it names the step and not the URL,
			// which would publish the sandbox's internal topology.
			return fmt.Errorf("%s did not become ready within %s (last probe: %w)", step.Name, timeout, last)
		case <-ticker.C:
		}
	}
}

// Stop tears the sandbox down: SIGTERM to every child in reverse start order,
// SIGKILL after stopGrace.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	if s.phase == PhaseStopping {
		s.mu.Unlock()
		return
	}
	s.phase = PhaseStopping
	running := append([]*exec.Cmd(nil), s.running...)
	s.running = nil
	s.mu.Unlock()

	for i := len(running) - 1; i >= 0; i-- {
		terminate(running[i])
	}
}

func terminate(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopGrace):
		_ = cmd.Process.Kill()
	}
}

// Heartbeat re-reports a ready sandbox until ctx ends. Idle reaping keys off
// the control plane's last check-in, so a sandbox that stops reporting is
// eventually stopped — which is the correct outcome for one that has wedged.
func (s *Supervisor) Heartbeat(ctx context.Context) {
	if s.reporter == nil || s.heartbeat <= 0 {
		return
	}
	ticker := time.NewTicker(s.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			phase, reason := s.snapshot()
			if err := s.reporter.Report(ctx, phase, reason); err != nil {
				s.log.Warn("Sandbox check-in failed", "phase", phase, "error", Redact(err.Error(), s.secrets...))
			}
		}
	}
}

func (s *Supervisor) snapshot() (Phase, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.phase, s.reason
}

func (s *Supervisor) setPhase(ctx context.Context, phase Phase, reason string) {
	if phase == "" {
		return
	}
	s.mu.Lock()
	if s.phase == phase && s.reason == reason {
		s.mu.Unlock()
		return
	}
	s.phase, s.reason = phase, reason
	s.mu.Unlock()

	s.log.Info("Sandbox phase", "phase", phase, "reason", reason)
	if s.reporter == nil {
		return
	}
	// Reporting must not hold up bring-up: a slow or unreachable control plane
	// is not a reason for the sandbox to stall, and the heartbeat will carry the
	// state through on the next tick.
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	go func() {
		defer cancel()
		if err := s.reporter.Report(reportCtx, phase, reason); err != nil {
			s.log.Warn("Sandbox state report failed", "phase", phase, "error", Redact(err.Error(), s.secrets...))
		}
	}()
}

func (s *Supervisor) fail(ctx context.Context, err error) error {
	reason := Redact(err.Error(), s.secrets...)
	s.setPhase(ctx, PhaseFailed, reason)
	return errors.New(reason)
}

// stripEnv removes named variables from an inherited environment.
//
// A child that does not need a secret must not be handed one. The sandbox
// runtime's ticket key is the case that matters: the agent harness runs as the
// same user in the same sandbox, and an inherited signing key would let it mint
// connection tickets for its own sandbox.
func stripEnv(inherited []string, remove []string) []string {
	if len(remove) == 0 {
		return inherited
	}
	excluded := make(map[string]struct{}, len(remove))
	for _, name := range remove {
		excluded[name] = struct{}{}
	}
	kept := make([]string, 0, len(inherited))
	for _, entry := range inherited {
		name, _, _ := strings.Cut(entry, "=")
		if _, drop := excluded[name]; drop {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

// mergeEnv layers overrides onto an inherited environment, last value winning.
func mergeEnv(inherited []string, overrides map[string]string) []string {
	if len(overrides) == 0 {
		return inherited
	}
	merged := make([]string, 0, len(inherited)+len(overrides))
	for _, entry := range inherited {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, overridden := overrides[name]; overridden {
				continue
			}
		}
		merged = append(merged, entry)
	}
	for name, value := range overrides {
		merged = append(merged, name+"="+value)
	}
	return merged
}

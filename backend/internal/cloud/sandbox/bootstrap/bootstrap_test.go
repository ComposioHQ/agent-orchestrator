package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	cloudruntime "github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/ticket"
)

const (
	testCapability = "aocap_v1.grant-id-value.super-secret-capability-material"
	testKeyBase64  = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
)

func baseEnv() map[string]string {
	return map[string]string{
		cloudruntime.EnvControlPlaneURL: "https://cloud.example.test",
		cloudruntime.EnvCapability:      testCapability,
		cloudruntime.EnvOrgID:           "org-1",
		cloudruntime.EnvWorkspaceID:     "ws-1",
		cloudruntime.EnvSessionID:       "sess-42",
		cloudruntime.EnvRuntimeID:       "rt-7",
		cloudruntime.EnvRole:            "worker",
		EnvTicketKey:                    testKeyBase64,
	}
}

func lookup(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

func TestLoadDefaultsToTheDaemonsLoopbackMux(t *testing.T) {
	cfg, err := Load(lookup(baseEnv()))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.UpstreamMuxURL() != "ws://"+DefaultDaemonAddr+"/mux" {
		t.Fatalf("upstream mux = %q", cfg.UpstreamMuxURL())
	}
	if cfg.DaemonReadyURL() != "http://"+DefaultDaemonAddr+"/readyz" {
		t.Fatalf("daemon readiness = %q", cfg.DaemonReadyURL())
	}
	if cfg.ListenAddr != DefaultListenAddr {
		t.Fatalf("listen address = %q", cfg.ListenAddr)
	}
	if got := cfg.ReportURL(); got != "https://cloud.example.test/api/cloud/v1/sandboxes/rt-7/state" {
		t.Fatalf("report URL = %q", got)
	}
	binding := cfg.Binding()
	if binding.SessionID != "sess-42" || binding.RuntimeID != "rt-7" {
		t.Fatalf("ticket binding = %+v", binding)
	}
}

// The verifier cannot be built without a session, so a sandbox that does not
// know its own placement must fail at load rather than at first connection.
func TestLoadRequiresThePlacementIdentifiers(t *testing.T) {
	for _, missing := range []string{cloudruntime.EnvSessionID, cloudruntime.EnvRuntimeID, EnvTicketKey} {
		env := baseEnv()
		delete(env, missing)
		if _, err := Load(lookup(env)); err == nil {
			t.Fatalf("Load succeeded without %s", missing)
		}
	}
}

// Half of the control-plane pair is a misconfiguration, not an offline mode.
func TestLoadRefusesHalfAControlPlane(t *testing.T) {
	for _, missing := range []string{cloudruntime.EnvControlPlaneURL, cloudruntime.EnvCapability} {
		env := baseEnv()
		delete(env, missing)
		if _, err := Load(lookup(env)); err == nil {
			t.Fatalf("Load succeeded with only half the control-plane configuration (%s missing)", missing)
		}
	}
	// Neither is a supported mode: a sandbox brought up by hand for debugging.
	env := baseEnv()
	delete(env, cloudruntime.EnvControlPlaneURL)
	delete(env, cloudruntime.EnvCapability)
	cfg, err := Load(lookup(env))
	if err != nil {
		t.Fatalf("Load without a control plane: %v", err)
	}
	if cfg.ReportURL() != "" {
		t.Fatalf("report URL = %q, want empty with no control plane", cfg.ReportURL())
	}
	reporter, err := NewHTTPReporter(cfg, nil)
	if err != nil {
		t.Fatalf("NewHTTPReporter: %v", err)
	}
	if reporter != nil {
		t.Fatal("NewHTTPReporter returned a reporter with no control plane to report to")
	}
}

func TestLoadRejectsMalformedArgv(t *testing.T) {
	for _, raw := range []string{"ao start", `{"cmd":"ao"}`, `["ao",""]`, `[`} {
		env := baseEnv()
		env[EnvHarnessArgv] = raw
		if _, err := Load(lookup(env)); err == nil {
			t.Fatalf("Load accepted harness argv %q", raw)
		}
	}
}

// One setting decides both where the daemon listens and where the listener
// relays to; configuring them apart is how a sandbox publishes a mux that
// points at nothing.
func TestDaemonStepBindsThePortTheListenerRelaysTo(t *testing.T) {
	env := baseEnv()
	env[EnvDaemonAddr] = "127.0.0.1:4599"
	cfg, err := Load(lookup(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	steps := cfg.Steps()
	if len(steps) != 1 {
		t.Fatalf("steps = %d, want just the daemon with no harness declared", len(steps))
	}
	if got := steps[0].Env["AO_PORT"]; got != "4599" {
		t.Fatalf("daemon AO_PORT = %q, want 4599", got)
	}
	if !strings.Contains(cfg.UpstreamMuxURL(), "4599") {
		t.Fatalf("upstream mux = %q, want it to name the daemon's port", cfg.UpstreamMuxURL())
	}
}

func TestHarnessStepIsDeclaredOnlyWhenConfigured(t *testing.T) {
	env := baseEnv()
	env[EnvHarnessArgv] = `["claude","--print"]`
	env[EnvWorkspaceDir] = "/workspace/repo"
	cfg, err := Load(lookup(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	steps := cfg.Steps()
	if len(steps) != 2 || steps[1].Name != "harness" {
		t.Fatalf("steps = %+v, want daemon then harness", steps)
	}
	if steps[1].Dir != "/workspace/repo" {
		t.Fatalf("harness dir = %q", steps[1].Dir)
	}
	if steps[0].Phase != PhaseDaemon || steps[1].Phase != PhaseHarness {
		t.Fatalf("phases = %q, %q", steps[0].Phase, steps[1].Phase)
	}
}

// ---- supervision -------------------------------------------------------

type recordingReporter struct {
	mu     sync.Mutex
	phases []Phase
	err    error
}

func (r *recordingReporter) Report(_ context.Context, phase Phase, _ string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.phases = append(r.phases, phase)
	return r.err
}

func (r *recordingReporter) seen() []Phase {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Phase(nil), r.phases...)
}

func (r *recordingReporter) waitFor(t *testing.T, want Phase) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, phase := range r.seen() {
			if phase == want {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("control plane never heard phase %q; saw %v", want, r.seen())
}

// gatedProbe passes only once released, so the test controls exactly when a
// step becomes ready.
type gatedProbe struct {
	mu       sync.Mutex
	released map[string]bool
}

func newGatedProbe() *gatedProbe { return &gatedProbe{released: map[string]bool{}} }

func (p *gatedProbe) release(url string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.released[url] = true
}

func (p *gatedProbe) probe(_ context.Context, url string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.released[url] {
		return nil
	}
	return errors.New("not ready")
}

func sleepStep(name string, phase Phase, readyURL string) Step {
	return Step{
		Name:         name,
		Argv:         []string{"/bin/sh", "-c", "sleep 30"},
		Phase:        phase,
		ReadyURL:     readyURL,
		ReadyTimeout: 3 * time.Second,
	}
}

// syncBuffer is a concurrency-safe log sink. Child output is written from the
// exec goroutine while the test reads, which the race detector rightly objects
// to on a bare bytes.Buffer.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newTestSupervisor(t *testing.T, steps []Step, probe func(context.Context, string) error) (*Supervisor, *recordingReporter, *syncBuffer) {
	t.Helper()
	reporter := &recordingReporter{}
	logs := &syncBuffer{}
	supervisor, err := NewSupervisor(Options{
		Steps:    steps,
		Reporter: reporter,
		Logger:   slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Secrets:  []string{testCapability},
		Probe:    probe,
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	t.Cleanup(supervisor.Stop)
	return supervisor, reporter, logs
}

func TestStepsStartInOrderAndGateOnReadiness(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	probe := newGatedProbe()
	steps := []Step{
		sleepStep("daemon", PhaseDaemon, "http://127.0.0.1:3001/readyz"),
		sleepStep("harness", PhaseHarness, ""),
	}
	supervisor, reporter, _ := newTestSupervisor(t, steps, probe.probe)

	done := make(chan error, 1)
	go func() { done <- supervisor.Start(context.Background()) }()

	// Until the daemon's probe passes, the sandbox must not be ready: the
	// published listener relays to a daemon that is not answering yet.
	reporter.waitFor(t, PhaseDaemon)
	if _, ready, _ := supervisor.Ready(); ready {
		t.Fatal("sandbox reported ready before the daemon answered its probe")
	}

	probe.release("http://127.0.0.1:3001/readyz")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Start never finished")
	}

	phase, ready, reason := supervisor.Ready()
	if !ready || phase != string(PhaseReady) || reason != "" {
		t.Fatalf("Ready() = %q, %v, %q", phase, ready, reason)
	}
	reporter.waitFor(t, PhaseHarness)
	reporter.waitFor(t, PhaseReady)
}

func TestAStepThatNeverBecomesReadyFailsTheSandbox(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	steps := []Step{sleepStep("daemon", PhaseDaemon, "http://127.0.0.1:3001/readyz")}
	steps[0].ReadyTimeout = 300 * time.Millisecond
	supervisor, reporter, _ := newTestSupervisor(t, steps, func(context.Context, string) error {
		return errors.New("connection refused")
	})

	err := supervisor.Start(context.Background())
	if err == nil {
		t.Fatal("Start succeeded with a step that never became ready")
	}
	if !strings.Contains(err.Error(), "daemon") {
		t.Fatalf("error %q does not name the step", err)
	}
	// The reason reaches an unauthenticated /readyz, so it must name the step
	// and not the sandbox's internal topology.
	if strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("failure reason publishes the sandbox's internal address: %q", err)
	}
	if _, ready, _ := supervisor.Ready(); ready {
		t.Fatal("sandbox is ready after a failed step")
	}
	reporter.waitFor(t, PhaseFailed)
}

// A step that exits is a failed sandbox, not something to restart in place: the
// daemon took the session's tmux server and panes with it.
func TestAnExitedStepFailsTheSandboxAndIsNotRestarted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	steps := []Step{{
		Name:  "daemon",
		Argv:  []string{"/bin/sh", "-c", "exit 3"},
		Phase: PhaseDaemon,
	}}
	supervisor, reporter, _ := newTestSupervisor(t, steps, func(context.Context, string) error { return nil })
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	reporter.waitFor(t, PhaseFailed)
	phase, ready, reason := supervisor.Ready()
	if ready || phase != string(PhaseFailed) {
		t.Fatalf("Ready() = %q, %v", phase, ready)
	}
	if !strings.Contains(reason, "daemon exited") {
		t.Fatalf("reason = %q, want it to say the daemon exited", reason)
	}
}

func TestStopTerminatesEveryChild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	steps := []Step{sleepStep("daemon", PhaseDaemon, "")}
	supervisor, _, _ := newTestSupervisor(t, steps, func(context.Context, string) error { return nil })
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	supervisor.mu.RLock()
	if len(supervisor.running) != 1 {
		supervisor.mu.RUnlock()
		t.Fatal("no child recorded")
	}
	pid := supervisor.running[0].Process.Pid
	supervisor.mu.RUnlock()

	supervisor.Stop()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if process, err := os.FindProcess(pid); err != nil || process.Signal(nil) != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child %d is still running after Stop", pid)
}

// ---- secrets -----------------------------------------------------------

// The compute plane enforces no-secrets-in-argv at the create call; this is the
// same rule re-applied where the process is actually spawned, because a step
// assembled inside the sandbox is a second place a credential could reach a
// command line that the tenant's own agent can read out of /proc.
func TestASecretOnAStepsCommandLineIsRefused(t *testing.T) {
	_, err := NewSupervisor(Options{
		Steps: []Step{{
			Name:  "harness",
			Argv:  []string{"claude", "--token=" + testCapability},
			Env:   map[string]string{cloudruntime.EnvCapability: testCapability},
			Phase: PhaseHarness,
		}},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil {
		t.Fatal("NewSupervisor accepted a secret on a command line")
	}
	if strings.Contains(err.Error(), testCapability) {
		t.Fatalf("the refusal quoted the secret: %q", err)
	}
}

func TestBootstrapNeverLogsSecretValues(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	// A child that echoes its own environment: the realistic way a credential
	// reaches a log line is a program printing its configuration on an error.
	steps := []Step{{
		Name:  "daemon",
		Argv:  []string{"/bin/sh", "-c", `printf 'boot failed with %s\n' "$AO_CLOUD_CAPABILITY" >&2; sleep 30`},
		Env:   map[string]string{cloudruntime.EnvCapability: testCapability},
		Phase: PhaseDaemon,
	}}
	supervisor, _, logs := newTestSupervisor(t, steps, func(context.Context, string) error { return nil })
	if err := supervisor.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(logs.String(), "boot failed") {
		time.Sleep(20 * time.Millisecond)
	}
	captured := logs.String()
	if !strings.Contains(captured, "boot failed") {
		t.Fatalf("the child's output never reached the log: %s", captured)
	}
	if strings.Contains(captured, testCapability) {
		t.Fatalf("the capability leaked into the log: %s", captured)
	}
	if !strings.Contains(captured, redacted) {
		t.Fatalf("the secret was not replaced with a placeholder: %s", captured)
	}
}

// Redaction scans for values, not names: a credential copied into an unlisted
// variable or embedded in a URL is the case name-based redaction misses.
func TestRedactWorksOnValuesRatherThanNames(t *testing.T) {
	line := "GET https://cloud.example.test/hook?token=" + testCapability + " failed"
	got := Redact(line, testCapability)
	if strings.Contains(got, testCapability) {
		t.Fatalf("Redact left the secret in %q", got)
	}
	if !strings.Contains(got, "cloud.example.test") {
		t.Fatalf("Redact removed more than the secret: %q", got)
	}
	// A short value is not treated as a secret; blanking it would redact
	// ordinary words out of every log line.
	if got := Redact("port 3001 is open", "3001"); got != "port 3001 is open" {
		t.Fatalf("Redact blanked a short value: %q", got)
	}
	// Overlapping secrets are replaced whole, longest first.
	if got := Redact("value="+testCapability, testCapability[:20], testCapability); strings.Contains(got, testCapability[:20]) {
		t.Fatalf("Redact left a fragment behind: %q", got)
	}
}

// ---- reporting ---------------------------------------------------------

func TestReporterAuthenticatesWithTheCapabilityAndCarriesNoneInTheBody(t *testing.T) {
	type captured struct {
		authorization string
		body          stateReport
	}
	got := make(chan captured, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body stateReport
		_ = json.NewDecoder(r.Body).Decode(&body)
		got <- captured{authorization: r.Header.Get("Authorization"), body: body}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	env := baseEnv()
	env[cloudruntime.EnvControlPlaneURL] = server.URL
	cfg, err := Load(lookup(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	reporter, err := NewHTTPReporter(cfg, server.Client())
	if err != nil {
		t.Fatalf("NewHTTPReporter: %v", err)
	}
	if err := reporter.Report(context.Background(), PhaseReady, ""); err != nil {
		t.Fatalf("Report: %v", err)
	}
	select {
	case c := <-got:
		if c.authorization != "Bearer "+testCapability {
			t.Fatalf("authorization = %q", c.authorization)
		}
		if !c.body.Ready || c.body.Phase != string(PhaseReady) {
			t.Fatalf("body = %+v", c.body)
		}
		if c.body.RuntimeID != "rt-7" || c.body.SessionID != "sess-42" {
			t.Fatalf("body = %+v, want the placement for correlation", c.body)
		}
		encoded, _ := json.Marshal(c.body)
		if strings.Contains(string(encoded), testCapability) {
			t.Fatalf("the report body carried the capability: %s", encoded)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the control plane never received a report")
	}
}

func TestReporterSurfacesRejectionsWithoutTheCredential(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A control plane echoing the presented credential back is exactly the
		// case that must not end up in a sandbox log.
		http.Error(w, "rejected "+r.Header.Get("Authorization"), http.StatusForbidden)
	}))
	defer server.Close()

	env := baseEnv()
	env[cloudruntime.EnvControlPlaneURL] = server.URL
	cfg, err := Load(lookup(env))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	reporter, err := NewHTTPReporter(cfg, server.Client())
	if err != nil {
		t.Fatalf("NewHTTPReporter: %v", err)
	}
	err = reporter.Report(context.Background(), PhaseReady, "")
	if err == nil {
		t.Fatal("Report succeeded against a rejecting control plane")
	}
	if strings.Contains(err.Error(), testCapability) {
		t.Fatalf("the error carried the capability: %v", err)
	}
}

// A slow or unreachable control plane must not stall bring-up.
func TestReportingDoesNotBlockBringUp(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell steps are not spawned on Windows")
	}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	blocking := blockingReporter{release: release}
	supervisor, err := NewSupervisor(Options{
		Steps:    []Step{sleepStep("daemon", PhaseDaemon, "")},
		Reporter: blocking,
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Probe:    func(context.Context, string) error { return nil },
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	t.Cleanup(supervisor.Stop)

	done := make(chan error, 1)
	go func() { done <- supervisor.Start(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Start: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("bring-up stalled behind a slow control plane")
	}
}

type blockingReporter struct{ release chan struct{} }

func (r blockingReporter) Report(ctx context.Context, _ Phase, _ string) error {
	select {
	case <-r.release:
	case <-ctx.Done():
	}
	return nil
}

func TestTicketVerifierBuildsFromTheLoadedConfiguration(t *testing.T) {
	cfg, err := Load(lookup(baseEnv()))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	issuer, err := ticket.NewIssuer(cfg.TicketKey, nil, nil)
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}
	token, _, err := issuer.Issue(ticket.AudienceMux, cfg.Binding(), ticket.DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	verifier, err := ticket.NewVerifier(cfg.TicketKey, ticket.AudienceMux, cfg.Binding(), ticket.NewMemoryReplayGuard(nil), nil)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if _, err := verifier.Verify(token); err != nil {
		t.Fatalf("a ticket minted for this placement did not verify: %v", err)
	}
}

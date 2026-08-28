package conpty

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestStripEnvAssignments(t *testing.T) {
	tests := []struct {
		name            string
		argv            []string
		wantAssignments []string
		wantRest        []string
	}{
		{
			name:            "no env prefix returns argv unchanged",
			argv:            []string{"opencode", "--agent", "ao-x"},
			wantAssignments: nil,
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env prefix is split from the real command",
			argv:            []string{"env", "OPENCODE_CONFIG=C:/cfg.json", "opencode", "--agent", "ao-x"},
			wantAssignments: []string{"OPENCODE_CONFIG=C:/cfg.json"},
			wantRest:        []string{"opencode", "--agent", "ao-x"},
		},
		{
			name:            "env with no command left is untouched",
			argv:            []string{"env", "A=1", "B=2"},
			wantAssignments: nil,
			wantRest:        []string{"env", "A=1", "B=2"},
		},
		{
			name:            "a binary merely starting with env is not treated as a prefix",
			argv:            []string{"envoy", "--config", "x"},
			wantAssignments: nil,
			wantRest:        []string{"envoy", "--config", "x"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotAssignments, gotRest := stripEnvAssignments(tt.argv)
			if !reflect.DeepEqual(gotAssignments, tt.wantAssignments) {
				t.Errorf("assignments = %#v, want %#v", gotAssignments, tt.wantAssignments)
			}
			if !reflect.DeepEqual(gotRest, tt.wantRest) {
				t.Errorf("rest = %#v, want %#v", gotRest, tt.wantRest)
			}
		})
	}
}

func TestStartedHostKillFailureRetainsPartialCreateEvidence(t *testing.T) {
	isolateRegistry(t)
	startupErr := errors.New("pty-host READY response unavailable")
	killErr := errors.New("kill access denied")
	addr, pid, spawnErr := cleanupStartedHostFailure(livePID(), startupErr, func() error { return killErr })
	if addr != "" || pid != livePID() || !errors.Is(spawnErr, startupErr) || !errors.Is(spawnErr, killErr) {
		t.Fatalf("started-host cleanup = (%q, %d, %v), want retained pid and joined startup/kill errors", addr, pid, spawnErr)
	}

	runtime := New(Options{Spawner: func(context.Context, string, string, []string, map[string]string) (string, int, error) {
		return addr, pid, spawnErr
	}})
	_, err := runtime.Create(context.Background(), ports.RuntimeConfig{
		SessionID: "sess-kill-failed", WorkspacePath: t.TempDir(), Argv: []string{"codex"},
		Env: map[string]string{runtimeLaunchIDEnv: "launch-kill-failed"},
	})
	var effect ports.RuntimeEffectError
	if !errors.As(err, &effect) {
		t.Fatalf("Create error %T does not expose RuntimeEffectError: %v", err, err)
	}
	if effect.PossibleHandle().ID != "sess-kill-failed" || effect.EffectOutcome() != ports.RuntimeEffectPossible || effect.CleanupOutcome() != ports.RuntimeCleanupFailed {
		t.Fatalf("Create effect evidence = handle %+v effect %q cleanup %q", effect.PossibleHandle(), effect.EffectOutcome(), effect.CleanupOutcome())
	}
	if !strings.Contains(err.Error(), "kill access denied") {
		t.Fatalf("Create error lost cleanup outcome: %v", err)
	}

	// The possible handle must remain fenceable even after a daemon restart.
	// A live PID without a READY address is unknown, never exact absence.
	recovered := New(Options{})
	recovered.pidIsAlive = func(int) bool { return true }
	ref := ports.FencedRuntimeRef{
		Handle: effect.PossibleHandle(), SessionID: "sess-kill-failed", Generation: "launch-kill-failed",
	}
	probe := recovered.ProbeFencedRuntime(context.Background(), ref)
	if probe.Liveness != ports.FencedUnknown || probe.Reason != ports.FencedReasonProbeFailed {
		t.Fatalf("ProbeFencedRuntime partial create = %+v, want unknown/probe_failed", probe)
	}

	recovered.destroyWait = 0
	recovered.processFinder = func(int) (processKiller, error) {
		return processKillerFunc(func() error { return errors.New("force kill denied") }), nil
	}
	if destroyErr := recovered.Destroy(context.Background(), effect.PossibleHandle()); destroyErr == nil || !strings.Contains(destroyErr.Error(), "force kill denied") {
		t.Fatalf("Destroy partial create = %v, want retained cleanup failure", destroyErr)
	}
	probe = recovered.ProbeFencedRuntime(context.Background(), ref)
	if probe.Liveness != ports.FencedUnknown {
		t.Fatalf("ProbeFencedRuntime after failed cleanup = %+v, want unknown", probe)
	}
}

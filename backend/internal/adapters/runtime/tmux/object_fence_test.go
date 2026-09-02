package tmux

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	objectFenceSessionID = "sess-1"
	objectFenceLaunchID  = "launch-owned"
	objectFenceTmuxSID   = "$41"
	objectFenceTmuxPID   = "%73"
)

type replacementAfterProofRunner struct {
	calls                    []runnerCall
	replaced                 bool
	foreignTouched           bool
	returnMismatchedPanePIDs bool
}

func (r *replacementAfterProofRunner) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	command := tmuxCommandArgs(args)
	if len(command) == 0 {
		return nil, errors.New("missing tmux command")
	}
	target := commandTarget(command)
	switch command[0] {
	case "has-session":
		if !r.replaced {
			return nil, nil
		}
	case "list-panes":
		format := command[len(command)-1]
		if format == paneIdentityFormat && !r.replaced {
			r.replaced = true
			return []byte(objectFenceTmuxSID + "\t" + objectFenceTmuxPID + "\t" +
				ownedPaneCommand("/tmp/ao/running.json", objectFenceSessionID, objectFenceLaunchID) + "\n"), nil
		}
		if format == panePIDFormat && target == objectFenceTmuxSID && r.returnMismatchedPanePIDs {
			return []byte(objectFenceTmuxSID + "\t%74\t999\n"), nil
		}
	}

	if target == objectFenceSessionID || target == "="+objectFenceSessionID || target == objectFenceSessionID+":0.0" {
		r.foreignTouched = true
		return []byte("foreign replacement accepted the name target"), nil
	}
	return []byte("can't find session: immutable target"), &exec.ExitError{}
}

func commandTarget(command []string) string {
	for i := 0; i+1 < len(command); i++ {
		if command[i] == "-t" {
			return command[i+1]
		}
	}
	return ""
}

func newReplacementFenceRuntime(t *testing.T) (*Runtime, ports.RuntimeHandle, *replacementAfterProofRunner, *recordingReaper) {
	t.Helper()
	owner := ports.SupervisedProcessRef{SessionID: objectFenceSessionID, LaunchID: objectFenceLaunchID}
	handle, err := qualifiedRuntimeHandleForOwner(
		objectFenceSessionID,
		socketTarget{kind: socketTargetNamed, value: "ao"},
		owner,
	)
	if err != nil {
		t.Fatal(err)
	}
	runner := &replacementAfterProofRunner{}
	reaper := &recordingReaper{}
	runtime := New(Options{
		Binary:      "tmux-test",
		SocketName:  "ao",
		RunFilePath: "/tmp/ao/running.json",
		Timeout:     time.Second,
		Shell:       "/bin/sh",
	})
	runtime.runner = runner
	runtime.reapSessions = reaper.reap
	runtime.enterDelay = 0
	return runtime, handle, runner, reaper
}

func TestOwnerProofTargetsImmutablePaneWhenNameIsImmediatelyReplaced(t *testing.T) {
	tests := []struct {
		name       string
		operation  func(*Runtime, ports.RuntimeHandle) error
		subcommand string
		wantTarget string
	}{
		{
			name: "send-keys",
			operation: func(runtime *Runtime, handle ports.RuntimeHandle) error {
				return runtime.SendInput(context.Background(), handle, "continue")
			},
			subcommand: "send-keys",
			wantTarget: objectFenceTmuxPID,
		},
		{
			name: "capture-pane",
			operation: func(runtime *Runtime, handle ports.RuntimeHandle) error {
				_, err := runtime.GetOutput(context.Background(), handle, 10)
				return err
			},
			subcommand: "capture-pane",
			wantTarget: objectFenceTmuxPID,
		},
		{
			name: "respawn-pane",
			operation: func(runtime *Runtime, handle ports.RuntimeHandle) error {
				_, err := runtime.Restart(context.Background(), handle, ports.RuntimeConfig{
					SessionID:     objectFenceSessionID,
					WorkspacePath: "/tmp/worktree",
					Argv:          []string{"codex"},
					Env: map[string]string{
						"AO_RUN_FILE":           "/tmp/ao/running.json",
						"AO_SESSION_ID":         objectFenceSessionID,
						"AO_SUPERVISED_PROCESS": "1",
						runtimeLaunchEnv:        "launch-next",
					},
				})
				return err
			},
			subcommand: "respawn-pane",
			wantTarget: objectFenceTmuxPID,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runtime, handle, runner, _ := newReplacementFenceRuntime(t)
			if err := tt.operation(runtime, handle); err == nil {
				t.Fatal("operation unexpectedly reached the same-name replacement")
			}
			if runner.foreignTouched {
				t.Fatal("operation targeted the same-name foreign replacement")
			}
			var action []string
			for _, call := range runner.calls {
				command := tmuxCommandArgs(call.args)
				if len(command) > 0 && command[0] == tt.subcommand {
					action = command
				}
			}
			if got := commandTarget(action); got != tt.wantTarget {
				t.Fatalf("%s target = %q, want immutable %q; command=%#v", tt.subcommand, got, tt.wantTarget, action)
			}
		})
	}
}

func TestOwnerProofTargetsImmutableSessionForAttachAfterNameReplacement(t *testing.T) {
	runtime, handle, runner, _ := newReplacementFenceRuntime(t)
	var attachArgv []string
	runtime.spawnAttach = func(_ context.Context, argv, _ []string, _, _ uint16) (ports.Stream, error) {
		attachArgv = append([]string(nil), argv...)
		return nil, errors.New("immutable session disappeared")
	}
	if _, err := runtime.Attach(context.Background(), handle, 50, 220); err == nil {
		t.Fatal("Attach unexpectedly reached the same-name replacement")
	}
	if runner.foreignTouched {
		t.Fatal("Attach proof touched the same-name foreign replacement")
	}
	if got := commandTarget(tmuxCommandArgs(attachArgv[1:])); got != objectFenceTmuxSID {
		t.Fatalf("attach target = %q, want immutable %q; argv=%#v", got, objectFenceTmuxSID, attachArgv)
	}
}

func TestDestroyUsesImmutableSessionForPaneListAndKillAfterNameReplacement(t *testing.T) {
	runtime, handle, runner, reaper := newReplacementFenceRuntime(t)
	if err := runtime.Destroy(context.Background(), handle); err != nil {
		t.Fatalf("idempotent destroy of replaced owner: %v", err)
	}
	if runner.foreignTouched {
		t.Fatal("Destroy targeted the same-name foreign replacement")
	}
	targets := map[string]string{}
	for _, call := range runner.calls {
		command := tmuxCommandArgs(call.args)
		if len(command) > 0 && (command[0] == "list-panes" || command[0] == "kill-session") && runner.replaced {
			targets[command[0]] = commandTarget(command)
		}
	}
	for _, subcommand := range []string{"list-panes", "kill-session"} {
		if got := targets[subcommand]; got != objectFenceTmuxSID {
			t.Fatalf("%s target = %q, want immutable %q", subcommand, got, objectFenceTmuxSID)
		}
	}
	for _, pids := range reaper.pids {
		if len(pids) != 0 {
			t.Fatalf("foreign replacement descendants were reaped: %v", pids)
		}
	}
}

func TestDestroyRejectsMismatchedPaneIDsBeforeReaping(t *testing.T) {
	runtime, handle, runner, reaper := newReplacementFenceRuntime(t)
	runner.returnMismatchedPanePIDs = true
	if err := runtime.Destroy(context.Background(), handle); err != nil {
		t.Fatalf("idempotent destroy of replaced owner: %v", err)
	}
	for _, pids := range reaper.pids {
		if len(pids) != 0 {
			t.Fatalf("mismatched pane identity was reaped: %v", pids)
		}
	}
}

func TestResolveExactWithoutHistoricalLaunchConcludesOnlyExhaustiveAbsence(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	missing := fakeRunnerResult{out: []byte("can't find session: " + objectFenceSessionID), err: &exec.ExitError{}}
	tests := []struct {
		name      string
		primary   fakeRunnerResult
		wantError bool
	}{
		{name: "absent from every namespace", primary: missing},
		{name: "same name still exists", primary: fakeRunnerResult{}, wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			runner := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
				"named:ao":                 tt.primary,
				"path:" + historicalSocket: missing,
				"default":                  missing,
			}}
			runtime := New(Options{
				Binary:           "bundled-tmux-test",
				LegacyBinary:     "system-tmux-test",
				SocketName:       "ao",
				LegacySocketPath: historicalSocket,
				RunFilePath:      "/tmp/ao/running.json",
				Timeout:          time.Second,
			})
			runtime.runner = runner
			resolved, found, err := runtime.ResolveExactRuntimeHandle(
				context.Background(),
				ports.RuntimeHandle{ID: objectFenceSessionID},
				ports.SupervisedProcessRef{SessionID: objectFenceSessionID},
			)
			if tt.wantError {
				if found || !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
					t.Fatalf("ResolveExactRuntimeHandle = (%q, %v, %v), want missing-launch failure", resolved.ID, found, err)
				}
			} else if err != nil || found || resolved.ID != "" {
				t.Fatalf("ResolveExactRuntimeHandle = (%q, %v, %v), want conclusive absence", resolved.ID, found, err)
			}
			assertOnlyLegacyProbes(t, runner.calls, "named:ao", "path:"+historicalSocket, "default")
			for _, call := range runner.calls {
				if strings.Contains(strings.Join(call.args, " "), "list-panes") {
					t.Fatalf("empty-launch absence check inspected pane ownership: %+v", call)
				}
			}
		})
	}
}

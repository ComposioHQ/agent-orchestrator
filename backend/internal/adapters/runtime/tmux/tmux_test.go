package tmux

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// -- fakeRunner test seam --

type fakeRunner struct {
	calls   []runnerCall
	outputs [][]byte
	err     error
	hook    func(context.Context, int) error
}

type runnerCall struct {
	env  []string
	name string
	args []string
}

func (f *fakeRunner) Run(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	var out []byte
	if len(f.outputs) > 0 {
		out = f.outputs[0]
		f.outputs = f.outputs[1:]
	}
	if f.hook != nil {
		if err := f.hook(ctx, len(f.calls)); err != nil {
			return out, err
		}
	}
	if f.err != nil {
		return out, f.err
	}
	return out, nil
}

// -- reapSessions test seam --

// recordingReaper captures reapSessions calls instead of signaling real
// processes, so unit tests exercising Destroy never touch the host's process
// table.
type recordingReaper struct {
	pids   [][]int
	graces []time.Duration
}

func (rr *recordingReaper) reap(_ context.Context, pids []int, grace time.Duration) {
	rr.pids = append(rr.pids, append([]int(nil), pids...))
	rr.graces = append(rr.graces, grace)
}

// -- helpers --

func newTestRuntime(chunkSize int) (*Runtime, *fakeRunner) {
	fr := &fakeRunner{}
	r := New(Options{Binary: "tmux-test", Timeout: time.Second, Shell: "/bin/sh", ChunkSize: chunkSize})
	r.runner = fr
	r.enterDelay = 0                           // tests must not pay the real 300ms pre-Enter pause
	r.reapSessions = (&recordingReaper{}).reap // never signal real processes from unit tests
	return r, fr
}

// countCalls returns how many of fr's recorded calls invoked the given tmux
// subcommand (args[0]), e.g. "display-message" for pane cwd verification
// probes.
func countCalls(fr *fakeRunner, subcommand string) int {
	n := 0
	for _, c := range fr.calls {
		if tmuxSubcommand(c.args) == subcommand {
			n++
		}
	}
	return n
}

// -- Options / New tests --

func TestNewDefaultsToPortableShell(t *testing.T) {
	t.Setenv("SHELL", "")
	r := New(Options{})
	if got := r.shell; got != "/bin/sh" {
		t.Fatalf("default shell = %q, want /bin/sh", got)
	}
}

func TestNewPicksUpShellFromEnv(t *testing.T) {
	t.Setenv("SHELL", "/bin/zsh")
	r := New(Options{})
	if got := r.shell; got != "/bin/zsh" {
		t.Fatalf("shell = %q, want /bin/zsh", got)
	}
}

func TestNewPrefersBundledTmuxFromEnv(t *testing.T) {
	t.Setenv("AO_TMUX_BINARY", "/opt/ao/resources/tmux/bin/tmux")
	r := New(Options{})
	if got := r.binary; got != "/opt/ao/resources/tmux/bin/tmux" {
		t.Fatalf("binary = %q, want bundled tmux", got)
	}
}

func TestNewExplicitBinaryOverridesBundledTmuxEnv(t *testing.T) {
	t.Setenv("AO_TMUX_BINARY", "/opt/ao/resources/tmux/bin/tmux")
	r := New(Options{Binary: "tmux-test"})
	if got := r.binary; got != "tmux-test" {
		t.Fatalf("binary = %q, want explicit option", got)
	}
}

func TestNewUsesAppOwnedTmuxSocketFromEnv(t *testing.T) {
	t.Setenv("AO_TMUX_SOCKET_NAME", "ao")
	r := New(Options{Binary: "tmux-test"})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got, want := fr.calls[0].args, []string{"-L", "ao", "list-sessions"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestNewUsesSystemTmuxForLegacyDefaultSocket(t *testing.T) {
	binDir := t.TempDir()
	systemTmux := filepath.Join(binDir, "tmux")
	if err := os.WriteFile(systemTmux, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	bundledTmux := filepath.Join(t.TempDir(), "bundled-tmux")
	if err := os.WriteFile(bundledTmux, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	t.Setenv("AO_TMUX_BINARY", bundledTmux)
	t.Setenv("AO_TMUX_SOCKET_NAME", "ao")

	r := New(Options{})
	if got := r.binary; got != bundledTmux {
		t.Fatalf("binary = %q, want bundled tmux %q", got, bundledTmux)
	}
	if got := r.legacyBinary; got != systemTmux {
		t.Fatalf("legacy binary = %q, want system tmux %q", got, systemTmux)
	}
}

func TestNewLeavesLegacyTmuxUnavailableWithoutSystemTmux(t *testing.T) {
	bundledTmux := filepath.Join(t.TempDir(), "bundled-tmux")
	if err := os.WriteFile(bundledTmux, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	t.Setenv("AO_TMUX_BINARY", bundledTmux)
	t.Setenv("AO_TMUX_SOCKET_NAME", "ao")

	r := New(Options{})
	if got := r.legacyBinary; got != "" {
		t.Fatalf("legacy binary = %q, want unavailable", got)
	}
}

// TestExecRunnerRunsFromStableDir is the direct regression test for Fix 1:
// execRunner.Run must pin cmd.Dir to os.TempDir() rather than inheriting
// whatever the daemon process's own cwd happens to be. The first tmux CLI
// call auto-starts the persistent tmux server, which then keeps that cwd for
// its entire lifetime (issue #2775); without this pin a daemon started from a
// Squirrel/ShipIt staging directory permanently poisons the server once that
// staging directory is deleted by the next auto-update. This runs the real
// execRunner (not the fakeRunner test seam every other test in this file
// uses), so it is the only test that would catch a regression here.
func TestExecRunnerRunsFromStableDir(t *testing.T) {
	out, err := (execRunner{}).Run(context.Background(), nil, "sh", "-c", "pwd")
	if err != nil {
		t.Fatalf("execRunner.Run: %v", err)
	}
	got := strings.TrimSpace(string(out))

	// Resolve symlinks on both sides: macOS reports os.TempDir() under
	// /var/folders/... but pwd (and everything else) sees the real path under
	// /private/var/folders/..., so a raw string comparison would spuriously
	// fail there.
	gotResolved, err := filepath.EvalSymlinks(got)
	if err != nil {
		t.Fatalf("resolve pwd output %q: %v", got, err)
	}
	wantResolved, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatalf("resolve os.TempDir() %q: %v", os.TempDir(), err)
	}
	if gotResolved != wantResolved {
		t.Fatalf("execRunner ran from %q, want os.TempDir() %q", got, os.TempDir())
	}
}

// TestExecRunnerFallsBackWhenTempDirMissing pins the guard on Fix 1's pin.
// os.TempDir() returns $TMPDIR without checking it exists, so a stale or bogus
// TMPDIR would otherwise set cmd.Dir to a dead path and fail EVERY tmux command
// with "chdir <dir>: no such file or directory" — the same dead-cwd failure
// #2775 was about, just moved. Run must degrade to a directory that exists.
func TestExecRunnerFallsBackWhenTempDirMissing(t *testing.T) {
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "deleted-by-an-update"))
	if _, err := os.Stat(os.TempDir()); !os.IsNotExist(err) {
		t.Fatalf("precondition: os.TempDir() %q should not exist, stat err = %v", os.TempDir(), err)
	}

	out, err := (execRunner{}).Run(context.Background(), nil, "sh", "-c", "pwd")
	if err != nil {
		t.Fatalf("execRunner.Run with a missing TMPDIR: %v", err)
	}
	got := strings.TrimSpace(string(out))
	if info, err := os.Stat(got); err != nil || !info.IsDir() {
		t.Fatalf("execRunner ran from %q, want an existing directory (stat err = %v)", got, err)
	}
}

// -- command builder tests --

func TestCommandBuilders(t *testing.T) {
	if got, want := newSessionArgs("sess-1", "/tmp/ws", "/bin/sh", `echo hi; exec "${SHELL:-/bin/sh}" -i`),
		[]string{"new-session", "-d", "-s", "sess-1", "-x", "220", "-y", "50", "-c", "/tmp/ws", "/bin/sh", "-c", `echo hi; exec "${SHELL:-/bin/sh}" -i`}; !reflect.DeepEqual(got, want) {
		t.Fatalf("newSessionArgs = %#v, want %#v", got, want)
	}
	if got, want := respawnPaneArgs("sess-1", "/tmp/ws", "/bin/sh", "echo hi"),
		[]string{"respawn-pane", "-k", "-t", "sess-1:0.0", "-c", "/tmp/ws", "/bin/sh", "-c", "echo hi"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("respawnPaneArgs = %#v, want %#v", got, want)
	}
	// set-option uses pane-targeting (no = prefix).
	if got, want := setStatusOffArgs("sess-1"), []string{"set-option", "-t", "sess-1", "status", "off"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("setStatusOffArgs = %#v, want %#v", got, want)
	}
	if got, want := setWindowSizeLargestArgs("sess-1"), []string{"set-option", "-t", "sess-1", "window-size", "largest"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("setWindowSizeLargestArgs = %#v, want %#v", got, want)
	}
	if got, want := paneCurrentPathArgs("sess-1"), []string{"display-message", "-p", "-t", "sess-1", "#{pane_current_path}"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("paneCurrentPathArgs = %#v, want %#v", got, want)
	}
	if got, want := setMouseOnArgs("sess-1"), []string{"set-option", "-t", "sess-1", "mouse", "on"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("setMouseOnArgs = %#v, want %#v", got, want)
	}
	// kill-session and has-session use exact-match prefix =.
	if got, want := killSessionArgs("sess-1"), []string{"kill-session", "-t", "=sess-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("killSessionArgs = %#v, want %#v", got, want)
	}
	if got, want := hasSessionArgs("sess-1"), []string{"has-session", "-t", "=sess-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("hasSessionArgs = %#v, want %#v", got, want)
	}
	if got, want := panePIDArgs("sess-1"), []string{"display-message", "-p", "-t", "sess-1:0.0", "#{pane_pid}"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("panePIDArgs = %#v, want %#v", got, want)
	}
	// list-panes reaps whole-session (-s) with exact-match target and prints pane pids.
	if got, want := listPanePIDsArgs("sess-1"), []string{"list-panes", "-s", "-t", "=sess-1", "-F", "#{pane_pid}"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("listPanePIDsArgs = %#v, want %#v", got, want)
	}
	if got, want := sendKeysLiteralArgs("sess-1", "hello"), []string{"send-keys", "-t", "sess-1", "-l", "hello"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sendKeysLiteralArgs = %#v, want %#v", got, want)
	}
	if got, want := sendEnterArgs("sess-1"), []string{"send-keys", "-t", "sess-1", "Enter"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sendEnterArgs = %#v, want %#v", got, want)
	}
	if got, want := sendInterruptArgs("sess-1"), []string{"send-keys", "-t", "sess-1", "C-c"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("sendInterruptArgs = %#v, want %#v", got, want)
	}
	if got, want := capturePaneArgs("sess-1", 10), []string{"capture-pane", "-t", "sess-1", "-p", "-S", "-10"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("capturePaneArgs = %#v, want %#v", got, want)
	}
	if got, want := capturePaneStyledArgs("sess-1", 10), []string{"capture-pane", "-e", "-t", "sess-1", "-p", "-S", "-10"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("capturePaneStyledArgs = %#v, want %#v", got, want)
	}
}

// -- session name sanitization --

func TestSessionNameSanitizesSpecialChars(t *testing.T) {
	got, err := tmuxSessionName("repo/issue#42.1")
	if err != nil {
		t.Fatalf("tmuxSessionName: %v", err)
	}
	if !sessionIDPattern.MatchString(got) {
		t.Fatalf("sanitized id %q fails pattern", got)
	}
	if !strings.HasPrefix(got, "repo-issue-42-1-") {
		t.Fatalf("sanitized id = %q, want readable prefix", got)
	}
	if got == "repo/issue#42.1" {
		t.Fatal("sanitized id still contains raw unsafe characters")
	}
}

func TestSessionNamePassesThroughShortConforming(t *testing.T) {
	if got := SessionName("myproj-1"); got != "myproj-1" {
		t.Fatalf("SessionName = %q, want unchanged", got)
	}
}

func TestSessionNameMatchesCreateNaming(t *testing.T) {
	long := domain.SessionID(strings.Repeat("x", 60) + "-1")
	viaCreate, err := tmuxSessionName(long)
	if err != nil {
		t.Fatalf("tmuxSessionName: %v", err)
	}
	if got := SessionName(string(long)); got != viaCreate {
		t.Fatalf("SessionName = %q, but Create uses %q", got, viaCreate)
	}
	if SessionName(string(long)) == string(long) {
		t.Fatal("expected long id to be sanitised to a different name")
	}
}

// -- env key validation --

func TestCreateRejectsInvalidEnvKeys(t *testing.T) {
	r, fr := newTestRuntime(0)
	_ = fr
	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"echo", "hi"},
		Env:           map[string]string{"BAD KEY": "x"},
	})
	if err == nil || !strings.Contains(err.Error(), "invalid env key") {
		t.Fatalf("Create err = %v, want invalid env key", err)
	}
}

// -- Create tests --

func TestCreateIssuesNewSessionAndStatusOff(t *testing.T) {
	// new-session, display-message cwd verification, set-option status,
	// set-option mouse, set-option window-size, has-session (exit 0 = alive)
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	h, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"echo", "hi"},
		Env:           map[string]string{"AO_SESSION_ID": "sess-1"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(h.ID, "tmux-v1:") {
		t.Fatalf("handle ID = %q, want durable tmux-v1 qualified handle", h.ID)
	}
	// Expect 6 calls: new-session, display-message cwd verification,
	// set-option status, set-option mouse, set-option window-size, has-session.
	if len(fr.calls) != 6 {
		t.Fatalf("calls = %d, want 6", len(fr.calls))
	}

	// Call 0: new-session
	if got := tmuxSubcommand(fr.calls[0].args); got != "new-session" {
		t.Fatalf("call[0] = %q, want new-session", got)
	}
	// Check -s <id>, -c <cwd> are present.
	joined := strings.Join(fr.calls[0].args, " ")
	if !strings.Contains(joined, "-s sess-1") {
		t.Fatalf("new-session args missing -s sess-1: %v", fr.calls[0].args)
	}
	if !strings.Contains(joined, "-c /tmp/ws") {
		t.Fatalf("new-session args missing -c /tmp/ws: %v", fr.calls[0].args)
	}
	// Ensure -x and -y are set.
	if !strings.Contains(joined, "-x 220") || !strings.Contains(joined, "-y 50") {
		t.Fatalf("new-session args missing -x/-y: %v", fr.calls[0].args)
	}

	// Call 1: verify pane cwd.
	if got, want := tmuxCommandArgs(fr.calls[1].args), paneCurrentPathArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[1] = %#v, want %#v", got, want)
	}

	// Call 2: set-option status off (plain target, pane-targeting does not use =).
	if got, want := tmuxCommandArgs(fr.calls[2].args), setStatusOffArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[2] = %#v, want %#v", got, want)
	}

	// Call 3: set-option mouse on (enables wheel-scroll of the pane).
	if got, want := tmuxCommandArgs(fr.calls[3].args), setMouseOnArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[3] = %#v, want %#v", got, want)
	}

	// Call 4: set-option window-size largest (multi-client sizing, see
	// setWindowSizeLargestArgs).
	if got, want := tmuxCommandArgs(fr.calls[4].args), setWindowSizeLargestArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[4] = %#v, want %#v", got, want)
	}

	// Call 5: has-session (IsAlive, uses exact-match target =sess-1).
	if got, want := tmuxCommandArgs(fr.calls[5].args), hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[5] = %#v, want %#v", got, want)
	}
}

// TestQualifiedHandleRoutesEveryOperationAfterRuntimeRestart is the durable
// handle contract. The Runtime that created the session is deliberately thrown
// away, and its replacement is configured with a different primary socket. A
// qualified handle must still route every operation to the socket that actually
// owns the session; an in-memory sessionSockets cache cannot satisfy this test.
func TestQualifiedHandleRoutesEveryOperationAfterRuntimeRestart(t *testing.T) {
	creator := New(Options{
		Binary:     "tmux-test",
		SocketName: "ao",
		Timeout:    time.Second,
		Shell:      "/bin/sh",
	})
	createRunner := &fakeRunner{outputs: [][]byte{
		nil, []byte("/tmp/ws\n"), nil, nil, nil, nil,
	}}
	creator.runner = createRunner
	creator.enterDelay = 0
	creator.reapSessions = (&recordingReaper{}).reap

	handle, err := creator.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"agent"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(handle.ID, "tmux-v1:") {
		t.Errorf("Create handle = %q, want durable versioned tmux-v1 handle", handle.ID)
	}
	if handle.ID == "sess-1" {
		t.Error("Create returned the legacy bare session name")
	}

	// A changed primary socket makes accidental rediscovery observable. The
	// durable handle, not this fresh Runtime's configuration, must win.
	restarted := New(Options{
		Binary:     "tmux-test",
		SocketName: "replacement-primary",
		Timeout:    time.Second,
		Shell:      "/bin/sh",
	})
	routeRunner := &fakeRunner{outputs: [][]byte{
		nil,                // IsAlive
		[]byte("screen\n"), // GetOutput
		[]byte("styled\n"), // GetStyledOutput
		nil,                // Interrupt
		nil,                // SendInput
		nil, nil,           // SendMessage text + Enter
		nil, nil, // Restart respawn + liveness
		[]byte("100\n"),
		[]byte("100 1 /bin/sh\n101 100 /opt/ao agent-process supervise --session sess-1 --launch launch-1 -- codex\n102 101 codex\n"),
		[]byte("100\n"),
		[]byte("100 1 /bin/sh\n101 100 /opt/ao agent-process supervise --session sess-1 --launch launch-1 -- codex\n102 101 codex\n"),
		nil, nil, // Destroy pane list + kill
	}}
	restarted.runner = routeRunner
	restarted.enterDelay = 0
	restarted.reapSessions = (&recordingReaper{}).reap

	if alive, probeErr := restarted.IsAlive(context.Background(), handle); probeErr != nil || !alive {
		t.Errorf("IsAlive = (%v, %v), want (true, nil)", alive, probeErr)
	}
	if _, outputErr := restarted.GetOutput(context.Background(), handle, 10); outputErr != nil {
		t.Errorf("GetOutput: %v", outputErr)
	}
	if _, outputErr := restarted.GetStyledOutput(context.Background(), handle, 10); outputErr != nil {
		t.Errorf("GetStyledOutput: %v", outputErr)
	}
	if interruptErr := restarted.Interrupt(context.Background(), handle); interruptErr != nil {
		t.Errorf("Interrupt: %v", interruptErr)
	}
	if inputErr := restarted.SendInput(context.Background(), handle, "\x1b"); inputErr != nil {
		t.Errorf("SendInput: %v", inputErr)
	}
	if sendErr := restarted.SendMessage(context.Background(), handle, "hello"); sendErr != nil {
		t.Errorf("SendMessage: %v", sendErr)
	}
	if _, restartErr := restarted.Restart(context.Background(), handle, ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"agent", "resume"},
	}); restartErr != nil {
		t.Errorf("Restart: %v", restartErr)
	}
	owner := ports.SupervisedProcessRef{SessionID: "sess-1", LaunchID: "launch-1"}
	if alive, inspectErr := restarted.IsSupervisedProcessAlive(context.Background(), handle, owner); inspectErr != nil || !alive {
		t.Errorf("IsSupervisedProcessAlive = (%v, %v), want (true, nil)", alive, inspectErr)
	}
	if alive, inspectErr := restarted.IsExactSupervisedProcessAlive(context.Background(), handle, owner); inspectErr != nil || !alive {
		t.Errorf("IsExactSupervisedProcessAlive = (%v, %v), want (true, nil)", alive, inspectErr)
	}
	if destroyErr := restarted.Destroy(context.Background(), handle); destroyErr != nil {
		t.Errorf("Destroy: %v", destroyErr)
	}

	attachArgv, attachErr := restarted.attachCommand(handle)
	if attachErr != nil {
		t.Errorf("terminal attach command: %v", attachErr)
	} else if len(attachArgv) < 3 || attachArgv[1] != "-L" || attachArgv[2] != "ao" {
		t.Errorf("terminal attach argv = %#v, want qualified handle's -L ao target", attachArgv)
	}

	if len(routeRunner.calls) == 0 {
		t.Fatal("fresh Runtime made no tmux calls")
	}
	for i, call := range routeRunner.calls {
		if call.name == "ps" {
			continue
		}
		if call.name != "tmux-test" {
			t.Errorf("call %d binary = %q, want tmux-test", i, call.name)
			continue
		}
		if len(call.args) < 3 || call.args[0] != "-L" || call.args[1] != "ao" {
			t.Errorf("call %d %s routed to %q, want direct named:ao routing from durable handle",
				i, tmuxSubcommand(call.args), probeNamespace(call.args))
		}
	}
}

func TestCreateOnDefaultPinsCreationAndReturnedHandleToSameNamespace(t *testing.T) {
	creator := New(Options{Binary: "tmux-test", Timeout: time.Second, Shell: "/bin/sh"})
	createRunner := &fakeRunner{outputs: [][]byte{nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}}
	creator.runner = createRunner
	creator.reapSessions = (&recordingReaper{}).reap
	handle, err := creator.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"agent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for i, call := range createRunner.calls {
		if len(call.args) < 3 || call.args[0] != "-L" || call.args[1] != "default" {
			t.Fatalf("creation call %d = %#v, want explicit -L default", i, call.args)
		}
	}

	fresh := New(Options{Binary: "tmux-test", SocketName: "replacement", Timeout: time.Second})
	routeRunner := &fakeRunner{}
	fresh.runner = routeRunner
	if alive, probeErr := fresh.IsAlive(context.Background(), handle); probeErr != nil || !alive {
		t.Fatalf("fresh IsAlive = (%v, %v)", alive, probeErr)
	}
	if len(routeRunner.calls) != 1 || len(routeRunner.calls[0].args) < 3 ||
		routeRunner.calls[0].args[0] != "-L" || routeRunner.calls[0].args[1] != "default" {
		t.Fatalf("qualified operation = %+v, want explicit -L default", routeRunner.calls)
	}
}

func TestCreateLaunchCommandContainsKeepAliveShell(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent", "--flag"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The launch command is the last argument to new-session (after shellPath -c).
	args := fr.calls[0].args
	launchCmd := args[len(args)-1]
	if !strings.Contains(launchCmd, `exec "${SHELL:-/bin/sh}" -i`) {
		t.Fatalf("launch command missing keep-alive shell: %q", launchCmd)
	}
	if !strings.HasPrefix(launchCmd, "cd '/tmp/ws' || exit; ") {
		t.Fatalf("launch command missing cwd guard: %q", launchCmd)
	}
	if !strings.Contains(launchCmd, "'myagent'") {
		t.Fatalf("launch command missing quoted argv: %q", launchCmd)
	}
}

func TestCreateLaunchCommandExportsEnvVars(t *testing.T) {
	oldGetenv := getenv
	getenv = func(key string) string {
		if key == "PATH" {
			return "/usr/bin:/bin"
		}
		return ""
	}
	defer func() { getenv = oldGetenv }()

	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
		Env: map[string]string{
			"AO_SESSION_ID": "sess-1",
			"COLORTERM":     "ansi",
			"ODD":           "can't",
			"PATH":          "/custom/bin:/usr/bin",
		},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	args := fr.calls[0].args
	launchCmd := args[len(args)-1]
	for _, want := range []string{
		"unset NO_COLOR;",
		"export AO_SESSION_ID='sess-1';",
		"export COLORTERM='truecolor';",
		"export ODD='can'\\''t';",
		"export PATH='/custom/bin:/usr/bin';",
	} {
		if !strings.Contains(launchCmd, want) {
			t.Fatalf("launch command missing %q in: %q", want, launchCmd)
		}
	}
}

func TestBuildLaunchCommandPreservesExplicitNoColor(t *testing.T) {
	launchCmd := buildLaunchCommand(ports.RuntimeConfig{
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
		Env:           map[string]string{"NO_COLOR": "1"},
	})

	if !strings.Contains(launchCmd, "export NO_COLOR='1';") {
		t.Fatalf("launch command does not preserve configured NO_COLOR: %q", launchCmd)
	}
	if strings.Contains(launchCmd, "unset NO_COLOR;") {
		t.Fatalf("launch command unsets configured NO_COLOR: %q", launchCmd)
	}
	if !strings.Contains(launchCmd, "export COLORTERM='truecolor';") {
		t.Fatalf("launch command does not advertise true color: %q", launchCmd)
	}
}

func TestCreateDestroysAndReturnsErrorWhenPaneCWDDoesNotMatch(t *testing.T) {
	r, fr := newTestRuntime(0)
	// new-session, then a stale pane cwd on every one of the paneCwdVerifyAttempts
	// retries: the pane never settles on the workspace, so Create must exhaust
	// all attempts and fail with the typed mismatch error.
	fr.outputs = [][]byte{nil}
	for i := 0; i < paneCwdVerifyAttempts; i++ {
		fr.outputs = append(fr.outputs, []byte("/deleted/shipit\n"))
	}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
	})
	if err == nil || !strings.Contains(err.Error(), `started in "/deleted/shipit", want "/tmp/ws"`) {
		t.Fatalf("Create err = %v, want pane cwd mismatch", err)
	}
	if !errors.Is(err, ports.ErrRuntimeWorkspaceCwdMismatch) {
		t.Fatalf("Create err = %v, want wrapped ports.ErrRuntimeWorkspaceCwdMismatch", err)
	}
	if got := countCalls(fr, "display-message"); got != paneCwdVerifyAttempts {
		t.Fatalf("pane cwd verification attempts = %d, want %d", got, paneCwdVerifyAttempts)
	}
	if countCalls(fr, "kill-session") == 0 {
		t.Fatal("expected kill-session cleanup call when pane cwd verification fails")
	}
}

// TestVerifyPaneWorkingDirectoryKeepsMismatchErrorAfterLaterProbeFailure pins
// Fix 2's sticky-sentinel behavior: once an attempt has observed a genuine cwd
// mismatch, a later attempt that fails to even probe the pane (a transient
// tmux CLI error, not a mismatch) must not overwrite that classifiable error.
// Losing it would make the caller fall back to an opaque, unclassifiable
// error and regress the whole point of Fix 4 (mapping to a typed apierr).
func TestVerifyPaneWorkingDirectoryKeepsMismatchErrorAfterLaterProbeFailure(t *testing.T) {
	r, _ := newTestRuntime(0)
	fr := &fakeRunnerSequence{
		results: []fakeRunnerResult{
			{out: []byte("/deleted/shipit\n")},                // attempt 1: mismatch
			{err: errors.New("tmux: lost server connection")}, // attempt 2: probe failure
		},
	}
	r.runner = fr

	err := r.verifyPaneWorkingDirectory(context.Background(), "sess-1", "/tmp/ws")
	if err == nil {
		t.Fatal("verifyPaneWorkingDirectory: got nil, want error")
	}
	if !errors.Is(err, ports.ErrRuntimeWorkspaceCwdMismatch) {
		t.Fatalf("verifyPaneWorkingDirectory err = %v, want wrapped ports.ErrRuntimeWorkspaceCwdMismatch (the mismatch must survive the later probe failure)", err)
	}
}

// TestVerifyPaneWorkingDirectoryRetriesUntilMatch pins the retry behavior Fix 2
// depends on: buildLaunchCommand's `cd <workspace> || exit;` guard corrects a
// pane's cwd asynchronously, so the first sample right after `new-session` can
// still show the tmux server's (possibly poisoned) cwd even though the pane is
// about to land in the right place. Create must not fail on that stale first
// sample if a later sample matches.
func TestVerifyPaneWorkingDirectoryRetriesUntilMatch(t *testing.T) {
	r, fr := newTestRuntime(0)
	// new-session, then a stale sample, then a matching sample.
	fr.outputs = [][]byte{nil, []byte("/deleted/shipit\n"), []byte("/tmp/ws\n"), nil, nil, nil}

	h, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !strings.HasPrefix(h.ID, "tmux-v1:") {
		t.Fatalf("handle ID = %q, want durable tmux-v1 qualified handle", h.ID)
	}
	if got := countCalls(fr, "display-message"); got != 2 {
		t.Fatalf("pane cwd verification attempts = %d, want 2 (stale then matching)", got)
	}
}

// TestVerifyPaneWorkingDirectoryHonorsCancellation ensures the retry loop's
// select on ctx.Done() actually aborts a pending retry instead of always
// sleeping out the full retry budget.
func TestVerifyPaneWorkingDirectoryHonorsCancellation(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("/deleted/shipit\n")}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := r.verifyPaneWorkingDirectory(ctx, "sess-1", "/tmp/ws")
	if err == nil {
		t.Fatal("verifyPaneWorkingDirectory: got nil, want context cancellation error")
	}
	// The first attempt runs before the retry-delay select is reached, so one
	// verification call happens even though ctx is already canceled; the
	// second attempt's select must observe ctx.Done() rather than waiting out
	// paneCwdVerifyRetryDelay.
	if got := countCalls(fr, "display-message"); got != 1 {
		t.Fatalf("pane cwd verification attempts = %d, want 1 (canceled before the first retry)", got)
	}
}

func TestCreateDestroysAndReturnsErrorWhenNotAlive(t *testing.T) {
	// Every setup command succeeds; only the has-session liveness probe reports the
	// session as gone, so Create must fail on the liveness check specifically.
	r2, _ := newTestRuntime(0)
	fr3 := &fakeRunnerSelectiveErr{
		exitErrOn: "has-session",
		errOutput: []byte("can't find session: sess-1"),
	}
	r2.runner = fr3

	_, err := r2.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
	})
	if err == nil {
		t.Fatal("Create: got nil, want error when session not alive after create")
	}
	// The failure must come from the liveness probe, not from an earlier setup
	// command. Without this the test would still pass if a newly inserted tmux
	// call took the injected error first — which is exactly what happened once.
	if !strings.Contains(err.Error(), "exited before ready") {
		t.Fatalf("Create err = %v, want the liveness-check failure (exited before ready)", err)
	}
	sawHasSession := false
	for _, c := range fr3.calls {
		if tmuxSubcommand(c.args) == "has-session" {
			sawHasSession = true
		}
	}
	if !sawHasSession {
		t.Fatal("Create never reached the has-session liveness probe")
	}
	// Verify Destroy was called (kill-session).
	hasKill := false
	for _, c := range fr3.calls {
		if tmuxSubcommand(c.args) == "kill-session" {
			hasKill = true
		}
	}
	if !hasKill {
		t.Fatal("expected kill-session cleanup call when session not alive")
	}
}

// fakeRunnerSelectiveErr returns an exec.ExitError (carrying errOutput) for the
// call whose tmux subcommand is exitErrOn, and succeeds for every other call.
// Matching on the subcommand rather than a call index is deliberate: Create's
// command sequence grows over time, and an index would silently retarget the
// injected failure onto whichever command was inserted before the intended one.
type fakeRunnerSelectiveErr struct {
	calls     []runnerCall
	exitErrOn string
	errOutput []byte
}

func (f *fakeRunnerSelectiveErr) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	if tmuxSubcommand(args) == f.exitErrOn {
		return f.errOutput, &exec.ExitError{}
	}
	if tmuxSubcommand(args) == "display-message" {
		return []byte("/tmp/ws\n"), nil
	}
	return nil, nil
}

// fakeRunnerResult is one scripted response for fakeRunnerSequence: either out
// bytes (success) or err (failure).
type fakeRunnerResult struct {
	out []byte
	err error
}

// fakeRunnerSequence returns each result in results in order for successive
// Run calls, repeating the last result once results is exhausted. It ignores
// which tmux subcommand was invoked, which is enough for tests that only
// care about a fixed sequence of successes/failures across retries.
type fakeRunnerSequence struct {
	calls   []runnerCall
	results []fakeRunnerResult
}

func (f *fakeRunnerSequence) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)})
	idx := len(f.calls) - 1
	if idx >= len(f.results) {
		idx = len(f.results) - 1
	}
	res := f.results[idx]
	return res.out, res.err
}

// runtimeAmbiguity is the typed error contract for a legacy handle found in
// more than one namespace. The production error may expose richer candidate
// details; callers only need a stable errors.As classification.
type runtimeAmbiguity interface {
	error
	RuntimeAmbiguity() bool
}

func ownedPaneCommand(runFile, sessionID, launchID string) string {
	return "export AO_RUN_FILE=" + shellQuote(runFile) + "; " +
		"export AO_SESSION_ID=" + shellQuote(sessionID) + "; " +
		"export AO_SUPERVISED_PROCESS='1'; " +
		": 'agent-process' 'supervise' '--session' '" + sessionID + "' '--launch' '" + launchID + "' '--' 'codex'; exec sh"
}

func legacyPaneCommand(sessionID, launchID string) string {
	return "export AO_SESSION_ID=" + shellQuote(sessionID) + "; " +
		"export AO_SUPERVISED_PROCESS='1'; " +
		": 'agent-process' 'supervise' '--session' '" + sessionID + "' '--launch' '" + launchID + "' '--' 'codex'; exec sh"
}

// namespaceProbeRunner scripts read-only has-session results by socket target,
// so legacy discovery tests do not depend on probe order.
type namespaceProbeRunner struct {
	calls   []runnerCall
	results map[string]fakeRunnerResult
}

func (f *namespaceProbeRunner) Run(_ context.Context, env []string, name string, args ...string) ([]byte, error) {
	call := runnerCall{env: append([]string(nil), env...), name: name, args: append([]string(nil), args...)}
	f.calls = append(f.calls, call)
	result, ok := f.results[probeNamespace(args)]
	if !ok {
		return []byte("unexpected tmux namespace"), errors.New("unexpected tmux namespace")
	}
	return result.out, result.err
}

func probeNamespace(args []string) string {
	if len(args) >= 2 && args[0] == "-L" {
		if args[1] == "default" {
			return "default"
		}
		return "named:" + args[1]
	}
	if len(args) >= 2 && args[0] == "-S" {
		return "path:" + args[1]
	}
	return "default"
}

func tmuxSubcommand(args []string) string {
	args = tmuxCommandArgs(args)
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

func tmuxCommandArgs(args []string) []string {
	for len(args) > 0 {
		switch args[0] {
		case "-L", "-S", "-f":
			if len(args) < 2 {
				return nil
			}
			args = args[2:]
		default:
			return args
		}
	}
	return nil
}

func assertOnlyLegacyProbes(t *testing.T, calls []runnerCall, wantNamespaces ...string) {
	t.Helper()
	seen := make(map[string]int, len(wantNamespaces))
	for _, call := range calls {
		if tmuxSubcommand(call.args) == "has-session" {
			seen[probeNamespace(call.args)]++
		}
		joined := strings.Join(call.args, " ")
		for _, mutating := range []string{"new-session", "respawn-pane", "kill-session", "send-keys", "paste-buffer", "load-buffer"} {
			if strings.Contains(joined, mutating) {
				t.Errorf("legacy resolution issued mutating %s command: %q %#v", mutating, call.name, call.args)
			}
		}
	}
	for _, namespace := range wantNamespaces {
		if seen[namespace] != 1 {
			t.Errorf("namespace %q probe count = %d, want exactly 1; calls=%+v", namespace, seen[namespace], calls)
		}
	}
}

func TestBareLegacyHandleReportsAmbiguityAcrossAllNamespacesWithoutMutation(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		Timeout:          time.Second,
	})
	fr := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"named:ao":                 {}, // same bare name exists here
		"path:" + historicalSocket: {}, // and here
		"default":                  {}, // and here
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if alive {
		t.Error("ambiguous bare handle reported alive")
	}
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Errorf("IsAlive error = %v, want ErrRuntimeProbeInconclusive", err)
	}
	var ambiguity runtimeAmbiguity
	if !errors.As(err, &ambiguity) || !ambiguity.RuntimeAmbiguity() {
		t.Errorf("IsAlive error = %v, want typed runtime ambiguity", err)
	}
	assertOnlyLegacyProbes(t, fr.calls, "named:ao", "path:"+historicalSocket, "default")
}

func TestBareLegacyHandleProbeFailureIsInconclusiveAndDoesNotAdoptOrMutate(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		Timeout:          time.Second,
	})
	fr := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"named:ao": {}, // one plausible live owner is not enough while another probe failed
		"path:" + historicalSocket: {
			out: []byte("error connecting to historical socket (Connection refused)"),
			err: &exec.ExitError{},
		},
		"default": {out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if alive {
		t.Error("partially observed bare handle reported alive")
	}
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Errorf("IsAlive error = %v, want ErrRuntimeProbeInconclusive", err)
	}
	var ambiguity runtimeAmbiguity
	if errors.As(err, &ambiguity) {
		t.Errorf("probe failure was mislabeled as duplicate-owner ambiguity: %v", err)
	}
	assertOnlyLegacyProbes(t, fr.calls, "named:ao", "path:"+historicalSocket, "default")
}

func TestResolveRuntimeHandleUsesExactOwnerToDisambiguateLegacyDuplicates(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{}, // named candidate exists
		{}, // historical candidate exists
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-2") + "\n")},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n")},
		{out: []byte("200\n")},
		{out: []byte("200 1 /bin/sh\n")},
	}}
	r.runner = fr

	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-2",
	})
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want qualified historical handle", resolved.ID, found, err)
	}
	if !strings.HasPrefix(resolved.ID, "tmux-v1:") {
		t.Fatalf("resolved handle = %q, want tmux-v1 qualified handle", resolved.ID)
	}

	// The resolved handle must carry its historical socket across Runtime
	// replacement; proving this through IsAlive avoids coupling the test to the
	// opaque wire encoding.
	fresh := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "replacement-primary",
		Timeout:      time.Second,
	})
	routeRunner := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"path:" + historicalSocket: {},
	}}
	fresh.runner = routeRunner
	if alive, probeErr := fresh.IsAlive(context.Background(), resolved); probeErr != nil || !alive {
		t.Fatalf("resolved handle IsAlive = (%v, %v), want (true, nil)", alive, probeErr)
	}
	if len(routeRunner.calls) != 1 || probeNamespace(routeRunner.calls[0].args) != "path:"+historicalSocket {
		t.Fatalf("resolved calls = %+v, want one direct historical-socket probe", routeRunner.calls)
	}
}

func TestResolveRuntimeHandlePrefersLiveNewerOwnerOverDeadDBMatchingOwner(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{},
		{},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-db-old") + "\n")},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-live-new") + "\n")},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n")},
		{out: []byte("200\n")},
		{out: []byte("200 1 /bin/sh\n201 200 /opt/ao agent-process supervise --session sess-1 --launch launch-live-new -- codex\n202 201 codex\n")},
	}}
	r.runner = fr

	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-db-old",
	})
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want live newer historical owner", resolved.ID, found, err)
	}
	route, err := decodeRuntimeHandle(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if route.target.kind != socketTargetPath || route.target.value != historicalSocket {
		t.Fatalf("resolved target = %+v, want live historical socket", route.target)
	}
}

func TestResolveRuntimeHandleUsesRawSanitizedSessionWhenSelectingLiveOwner(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	rawSessionID := domain.SessionID("project/feature#42." + strings.Repeat("very-long-", 6))
	tmuxID := SessionName(string(rawSessionID))
	if tmuxID == string(rawSessionID) {
		t.Fatalf("tmux session name = raw session id %q, want sanitization", tmuxID)
	}

	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{},
		{},
		{out: []byte("can't find session: " + tmuxID), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, string(rawSessionID), "launch-db-old") + "\n")},
		{out: []byte(ownedPaneCommand(runFile, string(rawSessionID), "launch-live-new") + "\n")},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n")},
		{out: []byte("200\n")},
		{out: []byte("200 1 /bin/sh\n201 200 /opt/ao agent-process supervise --session " + string(rawSessionID) + " --launch launch-live-new -- codex\n202 201 codex\n")},
	}}
	r.runner = fr

	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: tmuxID}, ports.SupervisedProcessRef{
		SessionID: rawSessionID,
		LaunchID:  "launch-db-old",
	})
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want live newer historical owner", resolved.ID, found, err)
	}
	route, err := decodeRuntimeHandle(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if route.id != tmuxID || route.target.kind != socketTargetPath || route.target.value != historicalSocket {
		t.Fatalf("resolved route = %+v, want live historical owner under sanitized id %q", route, tmuxID)
	}
}

func TestResolveRuntimeHandleRepairsStaleLaunchFromUniqueOwnedHistoricalPane(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	const actualLaunch = "launch-actual"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{}, // same-named foreign session on the current named namespace
		{}, // AO-owned historical session
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("sleep 30\n")},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", actualLaunch) + "\n")},
	}}
	r.runner = fr

	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-stale-in-db",
	})
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want owned historical target", resolved.ID, found, err)
	}

	identityRunner := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"path:" + historicalSocket: {out: []byte(ownedPaneCommand(runFile, "sess-1", actualLaunch) + "\n")},
	}}
	r.runner = identityRunner
	identity, err := r.InspectRuntimeIdentity(context.Background(), resolved, "sess-1")
	if err != nil || !identity.OwnershipProven || identity.LaunchID != actualLaunch {
		t.Fatalf("InspectRuntimeIdentity = (%+v, %v), want proven launch %q", identity, err, actualLaunch)
	}
	if len(identityRunner.calls) != 1 || tmuxSubcommand(identityRunner.calls[0].args) != "list-panes" {
		t.Fatalf("identity calls = %+v, want one fresh pane_start_command read", identityRunner.calls)
	}
}

func TestResolveRuntimeHandlePreservesRawIdentityForSanitizedSessionAcrossRuntimeReplacements(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	const actualLaunch = "launch-actual"
	rawSessionID := domain.SessionID("project/feature with spaces and 🚀/" + strings.Repeat("very-long-", 6))
	tmuxID, err := tmuxSessionName(rawSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if tmuxID == string(rawSessionID) {
		t.Fatalf("tmux session name = raw session id %q, want sanitization", tmuxID)
	}

	resolver := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	resolveRunner := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: " + tmuxID), err: &exec.ExitError{}},
		{},
		{out: []byte("can't find session: " + tmuxID), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, string(rawSessionID), actualLaunch) + "\n")},
	}}
	resolver.runner = resolveRunner

	resolved, found, err := resolver.ResolveRuntimeHandle(
		context.Background(),
		ports.RuntimeHandle{ID: tmuxID},
		ports.SupervisedProcessRef{SessionID: rawSessionID, LaunchID: actualLaunch},
	)
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want canonical historical handle", resolved.ID, found, err)
	}
	route, err := decodeRuntimeHandle(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if route.id != tmuxID || route.target.kind != socketTargetPath || route.target.value != historicalSocket {
		t.Fatalf("resolved route = %+v, want sanitized session %q on historical socket", route, tmuxID)
	}

	// A replacement daemon must reread the raw AO_SESSION_ID from the pane while
	// continuing to address tmux by the sanitized name carried in the handle.
	inspector := New(Options{
		Binary:       "replacement-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "replacement-primary",
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	inspectRunner := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"path:" + historicalSocket: {out: []byte(ownedPaneCommand(runFile, string(rawSessionID), actualLaunch) + "\n")},
	}}
	inspector.runner = inspectRunner
	identity, err := inspector.InspectRuntimeIdentity(context.Background(), resolved, rawSessionID)
	if err != nil || !identity.OwnershipProven || identity.LaunchID != actualLaunch {
		t.Fatalf("InspectRuntimeIdentity = (%+v, %v), want raw-session ownership for launch %q", identity, err, actualLaunch)
	}
	if len(inspectRunner.calls) != 1 || !reflect.DeepEqual(
		tmuxCommandArgs(inspectRunner.calls[0].args),
		paneStartCommandsArgs(tmuxID),
	) {
		t.Fatalf("identity calls = %+v, want direct pane lookup by sanitized tmux id %q", inspectRunner.calls, tmuxID)
	}

	// A second replacement must restart and probe the same qualified target;
	// neither operation may rediscover by the raw domain session id.
	restarted := New(Options{
		Binary:       "second-replacement-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "second-replacement-primary",
		Timeout:      time.Second,
		Shell:        "/bin/sh",
	})
	restartRunner := &fakeRunnerSequence{results: []fakeRunnerResult{{}, {}}}
	restarted.runner = restartRunner
	restartedHandle, err := restarted.Restart(context.Background(), resolved, ports.RuntimeConfig{
		SessionID:     rawSessionID,
		WorkspacePath: "/tmp/worktree",
		Argv:          []string{"agent", "resume"},
	})
	if err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if restartedHandle != resolved {
		t.Fatalf("Restart handle = %+v, want qualified handle %+v", restartedHandle, resolved)
	}
	if len(restartRunner.calls) != 2 {
		t.Fatalf("restart calls = %+v, want respawn and liveness probe", restartRunner.calls)
	}
	for i, call := range restartRunner.calls {
		if got := probeNamespace(call.args); got != "path:"+historicalSocket {
			t.Errorf("restart call %d namespace = %q, want historical socket", i, got)
		}
	}
	if got := tmuxCommandArgs(restartRunner.calls[0].args); len(got) < 4 || got[0] != "respawn-pane" || got[3] != tmuxID+":0.0" {
		t.Fatalf("restart argv = %#v, want sanitized pane target %q", got, tmuxID+":0.0")
	}
	if got := tmuxCommandArgs(restartRunner.calls[1].args); !reflect.DeepEqual(got, hasSessionArgs(tmuxID)) {
		t.Fatalf("restart liveness argv = %#v, want %#v", got, hasSessionArgs(tmuxID))
	}
}

func TestPaneRuntimeIdentityRequiresExactAOProvenance(t *testing.T) {
	command := ownedPaneCommand("/tmp/ao/running.json", "sess-1", "launch-actual")
	if launchID, owned := paneRuntimeIdentity(command, "sess-1", "/tmp/ao/running.json"); !owned || launchID != "launch-actual" {
		t.Fatalf("paneRuntimeIdentity = (%q, %v), want exact owned launch", launchID, owned)
	}
	for label, candidate := range map[string]string{
		"other run file": strings.Replace(command, "'/tmp/ao/running.json'", "'/tmp/other/running.json'", 1),
		"other session":  strings.Replace(command, "'sess-1'", "'sess-foreign'", 1),
		"no marker":      strings.Replace(command, "export AO_SUPERVISED_PROCESS='1'; ", "", 1),
		"no supervisor":  strings.Replace(command, "'agent-process'", "'foreign-process'", 1),
	} {
		if _, owned := paneRuntimeIdentity(candidate, "sess-1", "/tmp/ao/running.json"); owned {
			t.Errorf("%s candidate was accepted as AO-owned: %q", label, candidate)
		}
	}
}

func TestResolveRuntimeHandleAllowsLaunchFencedPreRunFilePaneWithoutRepairAuthority(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	const launchID = "launch-durable"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(legacyPaneCommand("sess-1", launchID) + "\n")},
	}}
	r.runner = fr
	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  launchID,
	})
	if err != nil || !found {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want launch-fenced legacy pane", resolved.ID, found, err)
	}

	r.runner = &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"path:" + historicalSocket: {out: []byte(legacyPaneCommand("sess-1", launchID) + "\n")},
	}}
	identity, err := r.InspectRuntimeIdentity(context.Background(), resolved, "sess-1")
	if err != nil {
		t.Fatal(err)
	}
	if identity.OwnershipProven {
		t.Fatalf("pre-run-file identity = %+v, must not authorize stale-launch repair", identity)
	}
	if identity.LaunchID != launchID {
		t.Fatalf("pre-run-file launch = %q, want %q", identity.LaunchID, launchID)
	}
}

func TestResolveRuntimeHandleRejectsMismatchedPresentRunFileEvenWhenLaunchMatches(t *testing.T) {
	const runFile = "/tmp/ao/running.json"
	r := New(Options{Binary: "tmux-test", RunFilePath: runFile, Timeout: time.Second})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{},
		{out: []byte(ownedPaneCommand("/tmp/other/running.json", "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr
	_, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-1",
	})
	if found || !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("ResolveRuntimeHandle = (found=%v, err=%v), want foreign run-file rejected", found, err)
	}
}

func TestResolveRuntimeHandleWithoutOwnerRejectsLegacyDuplicates(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{},
		{},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-2") + "\n")},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n")},
		{out: []byte("200\n")},
		{out: []byte("200 1 /bin/sh\n")},
	}}
	r.runner = fr

	resolved, found, err := r.ResolveRuntimeHandle(
		context.Background(),
		ports.RuntimeHandle{ID: "sess-1"},
		ports.SupervisedProcessRef{},
	)
	if found || resolved.ID != "" {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want unresolved ambiguity", resolved.ID, found, err)
	}
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("ResolveRuntimeHandle error = %v, want ErrRuntimeProbeInconclusive", err)
	}
	var ambiguity runtimeAmbiguity
	if !errors.As(err, &ambiguity) || !ambiguity.RuntimeAmbiguity() {
		t.Fatalf("ResolveRuntimeHandle error = %v, want typed runtime ambiguity", err)
	}
	assertOnlyLegacyProbes(t, fr.calls, "named:ao", "path:"+historicalSocket, "default")
}

func TestResolveRuntimeHandleReturnsQualifiedHandleUnchangedWithoutProbing(t *testing.T) {
	r := New(Options{Binary: "tmux-test", SocketName: "replacement", Timeout: time.Second})
	fr := &fakeRunner{err: errors.New("must not probe")}
	r.runner = fr
	handle, err := qualifiedRuntimeHandle("sess-1", socketTarget{kind: socketTargetNamed, value: "ao"})
	if err != nil {
		t.Fatal(err)
	}
	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), handle, ports.SupervisedProcessRef{})
	if err != nil || !found || resolved != handle {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want unchanged qualified handle", resolved.ID, found, err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("qualified resolution probed runtime: %+v", fr.calls)
	}
}

func TestResolveRuntimeHandleReturnsNotFoundOnlyAfterEveryNamespaceIsAbsent(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      "/tmp/ao/running.json",
		Timeout:          time.Second,
	})
	missing := fakeRunnerResult{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}}
	fr := &namespaceProbeRunner{results: map[string]fakeRunnerResult{
		"named:ao":                 missing,
		"path:" + historicalSocket: missing,
		"default":                  missing,
	}}
	r.runner = fr
	resolved, found, err := r.ResolveRuntimeHandle(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{})
	if err != nil || found || resolved.ID != "" {
		t.Fatalf("ResolveRuntimeHandle = (%q, %v, %v), want conclusive not found", resolved.ID, found, err)
	}
	assertOnlyLegacyProbes(t, fr.calls, "named:ao", "path:"+historicalSocket, "default")
}

func TestRestartRespawnsExistingPaneAndPreservesHandle(t *testing.T) {
	r, fr := newTestRuntime(0)
	handle := ports.RuntimeHandle{ID: "sess-1"}
	cfg := ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex", "resume", "native-1"},
		Env:           map[string]string{"AO_SESSION_ID": "sess-1"},
	}

	got, err := r.Restart(context.Background(), handle, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got != handle {
		t.Fatalf("Restart handle = %+v, want %+v", got, handle)
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want respawn + liveness probe", len(fr.calls))
	}
	if args := tmuxCommandArgs(fr.calls[0].args); len(args) < 6 || args[0] != "respawn-pane" || args[1] != "-k" || args[3] != "sess-1:0.0" || args[5] != "/tmp/ws" {
		t.Fatalf("respawn args = %#v", args)
	}
	if args := tmuxCommandArgs(fr.calls[1].args); !reflect.DeepEqual(args, hasSessionArgs("sess-1")) {
		t.Fatalf("liveness args = %#v, want %#v", args, hasSessionArgs("sess-1"))
	}
}

func TestRestartRejectsMismatchedSessionHandle(t *testing.T) {
	r, fr := newTestRuntime(0)
	_, err := r.Restart(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.RuntimeConfig{
		SessionID:     "sess-2",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex"},
	})
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("Restart error = %v, want handle mismatch", err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runtime called after validation failure: %+v", fr.calls)
	}
}

func TestIsAliveAdoptsSessionFromLegacyDefaultSocket(t *testing.T) {
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "ao",
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr
	handle := ports.RuntimeHandle{ID: "sess-1"}

	for i := 0; i < 2; i++ {
		alive, err := r.IsAlive(context.Background(), handle)
		if err != nil || !alive {
			t.Fatalf("IsAlive call %d = (%v, %v), want (true, nil)", i+1, alive, err)
		}
	}
	want := [][]string{
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, paneStartCommandsArgs("sess-1")...),
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, paneStartCommandsArgs("sess-1")...),
	}
	wantBinaries := []string{
		"bundled-tmux-test",
		"system-tmux-test",
		"system-tmux-test",
		"bundled-tmux-test",
		"system-tmux-test",
		"system-tmux-test",
	}
	if len(fr.calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(fr.calls), len(want), fr.calls)
	}
	for i := range want {
		if fr.calls[i].name != wantBinaries[i] {
			t.Fatalf("call %d binary = %q, want %q", i, fr.calls[i].name, wantBinaries[i])
		}
		if !reflect.DeepEqual(fr.calls[i].args, want[i]) {
			t.Fatalf("call %d args = %#v, want %#v", i, fr.calls[i].args, want[i])
		}
	}
}

func TestIsAliveAdoptsSessionFromHistoricalPrivateSocket(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr
	handle := ports.RuntimeHandle{ID: "sess-1"}

	for i := 0; i < 2; i++ {
		alive, err := r.IsAlive(context.Background(), handle)
		if err != nil || !alive {
			t.Fatalf("IsAlive call %d = (%v, %v), want (true, nil)", i+1, alive, err)
		}
	}
	want := [][]string{
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, paneStartCommandsArgs("sess-1")...),
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, paneStartCommandsArgs("sess-1")...),
	}
	if len(fr.calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(fr.calls), len(want), fr.calls)
	}
	wantBinaries := []string{
		"bundled-tmux-test", "bundled-tmux-test", "system-tmux-test", "bundled-tmux-test",
		"bundled-tmux-test", "bundled-tmux-test", "system-tmux-test", "bundled-tmux-test",
	}
	for i := range want {
		if fr.calls[i].name != wantBinaries[i] {
			t.Fatalf("call %d binary = %q, want %q", i, fr.calls[i].name, wantBinaries[i])
		}
		if !reflect.DeepEqual(fr.calls[i].args, want[i]) {
			t.Fatalf("call %d args = %#v, want %#v", i, fr.calls[i].args, want[i])
		}
	}
}

func TestIsAliveAdoptsHistoricalPrivateSocketFromDefaultPrimary(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "tmux-test",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want (true, nil)", alive, err)
	}
	want := [][]string{
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, paneStartCommandsArgs("sess-1")...),
	}
	if len(fr.calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(fr.calls), len(want), fr.calls)
	}
	for i := range want {
		if !reflect.DeepEqual(fr.calls[i].args, want[i]) {
			t.Fatalf("call %d args = %#v, want %#v", i, fr.calls[i].args, want[i])
		}
	}
}

func TestIsAliveChecksLegacyDefaultAfterHistoricalPrivateSocketIsMissing(t *testing.T) {
	const historicalSocket = "/tmp/ao-legacy-private.sock"
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: historicalSocket,
		RunFilePath:      runFile,
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("no server running on " + historicalSocket), err: &exec.ExitError{}},
		{},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want (true, nil)", alive, err)
	}
	want := [][]string{
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-S", historicalSocket, "-f", os.DevNull}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, paneStartCommandsArgs("sess-1")...),
	}
	wantBinaries := []string{"bundled-tmux-test", "bundled-tmux-test", "system-tmux-test", "system-tmux-test"}
	if len(fr.calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(fr.calls), len(want), fr.calls)
	}
	for i := range want {
		if fr.calls[i].name != wantBinaries[i] || !reflect.DeepEqual(fr.calls[i].args, want[i]) {
			t.Fatalf("call %d = %q %#v, want %q %#v", i, fr.calls[i].name, fr.calls[i].args, wantBinaries[i], want[i])
		}
	}
}

func TestIsAliveReportsHistoricalPrivateSocketFailureAsInconclusive(t *testing.T) {
	r := New(Options{
		Binary:           "bundled-tmux-test",
		LegacyBinary:     "system-tmux-test",
		SocketName:       "ao",
		LegacySocketPath: "/tmp/ao-legacy-private.sock",
		Timeout:          time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("error connecting to historical socket (Connection refused)"), err: &exec.ExitError{}},
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false with inconclusive error")
	}
	if len(fr.calls) != 3 {
		t.Fatalf("calls = %d, want every configured namespace probed", len(fr.calls))
	}
}

func TestIsAliveAdoptsLegacyDefaultSessionWhenNamedSocketDoesNotExist(t *testing.T) {
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "ao",
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{
			out: []byte("error connecting to /private/tmp/tmux-501/ao (No such file or directory)"),
			err: &exec.ExitError{},
		},
		{},
		{out: []byte(ownedPaneCommand(runFile, "sess-1", "launch-1") + "\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want (true, nil)", alive, err)
	}
	want := [][]string{
		append([]string{"-L", "ao"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, hasSessionArgs("sess-1")...),
		append([]string{"-L", "default"}, paneStartCommandsArgs("sess-1")...),
	}
	wantBinaries := []string{"bundled-tmux-test", "system-tmux-test", "system-tmux-test"}
	if len(fr.calls) != len(want) {
		t.Fatalf("calls = %d, want %d: %+v", len(fr.calls), len(want), fr.calls)
	}
	for i := range want {
		if fr.calls[i].name != wantBinaries[i] {
			t.Fatalf("call %d binary = %q, want %q", i, fr.calls[i].name, wantBinaries[i])
		}
		if !reflect.DeepEqual(fr.calls[i].args, want[i]) {
			t.Fatalf("call %d args = %#v, want %#v", i, fr.calls[i].args, want[i])
		}
	}
}

func TestIsAliveKeepsAmbiguousNamedSocketFailureInNamedNamespace(t *testing.T) {
	r := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "ao",
		Timeout:      time.Second,
	})
	connectionRefused := fakeRunnerResult{
		out: []byte("error connecting to /private/tmp/tmux-501/ao (Connection refused)"),
		err: &exec.ExitError{},
	}
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{connectionRefused, connectionRefused}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false with inconclusive error")
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want named and default namespace probes", len(fr.calls))
	}
	if fr.calls[0].name != "bundled-tmux-test" || probeNamespace(fr.calls[0].args) != "named:ao" {
		t.Fatalf("named probe = %+v", fr.calls[0])
	}
	if fr.calls[1].name != "system-tmux-test" || probeNamespace(fr.calls[1].args) != "default" {
		t.Fatalf("default probe = %+v", fr.calls[1])
	}
}

func TestIsAliveReportsMissingLegacyClientAsProbeInconclusive(t *testing.T) {
	r := New(Options{Binary: "bundled-tmux-test", SocketName: "ao", Timeout: time.Second})
	r.legacyBinary = ""
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false with inconclusive error")
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want only the private-socket probe", len(fr.calls))
	}
}

func TestIsAliveReportsIncompatibleLegacyClientAsProbeInconclusive(t *testing.T) {
	r := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "ao",
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("server exited unexpectedly"), err: &exec.ExitError{}},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false with inconclusive error")
	}
	if !strings.Contains(err.Error(), "server exited unexpectedly") {
		t.Fatalf("IsAlive err = %v, want actionable legacy client failure", err)
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want private then legacy probes only", len(fr.calls))
	}
}

func TestIsAliveReportsTransientLegacyConnectionAsProbeInconclusive(t *testing.T) {
	r := New(Options{
		Binary:       "bundled-tmux-test",
		LegacyBinary: "system-tmux-test",
		SocketName:   "ao",
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("error connecting to /tmp/tmux-1000/default (Connection refused)"), err: &exec.ExitError{}},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false with inconclusive error")
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want private then legacy probes only", len(fr.calls))
	}
}

// -- Destroy tests --

func TestDestroyIsIdempotentWhenSessionMissing(t *testing.T) {
	r, fr := newTestRuntime(0)
	// First output feeds list-panes (which also errors here → no sids); the
	// missing-session marker must land on the kill-session call.
	fr.outputs = [][]byte{nil, []byte("can't find session: sess-1")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if len(fr.calls) != 2 || tmuxSubcommand(fr.calls[0].args) != "list-panes" || tmuxSubcommand(fr.calls[1].args) != "kill-session" {
		t.Fatalf("calls = %#v, want list-panes then kill-session", fr.calls)
	}
}

func TestDestroyIsIdempotentWhenNoServer(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, []byte("no server running on /tmp/tmux-1000/default")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy no-server: %v", err)
	}
}

func TestDestroyReportsUnexpectedFailures(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, []byte("permission denied")}
	fr.err = &exec.ExitError{}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err == nil {
		t.Fatal("Destroy: got nil, want unexpected failure error")
	}
}

func TestDestroyArgs(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil}

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	// list-panes discovers pane sessions; kill-session (exact-match target
	// =<id>) tears the session down.
	if got, want := tmuxCommandArgs(fr.calls[0].args), listPanePIDsArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("list-panes args = %#v, want %#v", got, want)
	}
	if got, want := tmuxCommandArgs(fr.calls[1].args), killSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("destroy args = %#v, want %#v", got, want)
	}
}

func TestIsSupervisedProcessAliveFindsExactDescendant(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{
		[]byte("100\n"),
		[]byte("100 1 /bin/sh -c launch\n101 100 /opt/ao agent-process supervise --session sess-1 --launch launch-2 -- codex\n102 101 codex\n"),
	}

	alive, err := r.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-2",
	})
	if err != nil || !alive {
		t.Fatalf("IsSupervisedProcessAlive = (%v, %v), want (true, nil)", alive, err)
	}
	if len(fr.calls) != 2 || fr.calls[1].name != "ps" {
		t.Fatalf("calls = %#v, want tmux pane lookup followed by ps", fr.calls)
	}
}

func TestIsSupervisedProcessAliveRejectsStaleAndUnrelatedProcesses(t *testing.T) {
	entries, err := parseProcessTable("100 1 /bin/sh\n101 100 /opt/ao agent-process supervise --session sess-1 --launch launch-old -- codex\n102 101 codex\n200 1 /opt/ao agent-process supervise --session sess-1 --launch launch-new -- codex\n201 200 codex\n")
	if err != nil {
		t.Fatal(err)
	}
	if containsExactSupervisedWorkload(entries, 100, "sess-1", "launch-new") {
		t.Fatal("stale descendant or matching process outside the pane tree was accepted")
	}
	if containsManagedWorkload(entries, 100, "sess-1", "launch-new") {
		t.Fatal("stale supervised generation was accepted as a manual workload")
	}
	if !containsExactSupervisedWorkload(entries, 100, "sess-1", "launch-old") {
		t.Fatal("exact supervised descendant was not found")
	}
}

func TestExactSupervisedWorkloadRejectsSupervisorReportingExitedChild(t *testing.T) {
	entries, err := parseProcessTable("100 1 /bin/sh\n101 100 /opt/ao agent-process supervise --session sess-1 --launch launch-2 -- codex\n")
	if err != nil {
		t.Fatal(err)
	}
	if containsExactSupervisedWorkload(entries, 100, "sess-1", "launch-2") {
		t.Fatal("supervisor without a managed child was accepted as a live target")
	}
	if !containsManagedWorkload(entries, 100, "sess-1", "launch-2") {
		t.Fatal("ordinary reaper should retain a supervisor while it reports the child exit")
	}
}

func TestIsSupervisedProcessAliveFindsManualRelaunchFromPreservedShell(t *testing.T) {
	entries, err := parseProcessTable("100 1 /bin/zsh -i\n101 100 codex resume native-1\n102 101 codex worker\n")
	if err != nil {
		t.Fatal(err)
	}
	if !containsManagedWorkload(entries, 100, "sess-1", "launch-2") {
		t.Fatal("workload relaunched from the preserved shell was not found")
	}
}

func TestIsExactSupervisedProcessAliveRejectsManualRelaunchFromPreservedShell(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{
		[]byte("100\n"),
		[]byte("100 1 /bin/zsh -i\n101 100 codex resume native-1\n102 101 codex worker\n"),
	}
	alive, err := r.IsExactSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{
		SessionID: "sess-1",
		LaunchID:  "launch-2",
	})
	if err != nil || alive {
		t.Fatalf("IsExactSupervisedProcessAlive = (%v, %v), want (false, nil)", alive, err)
	}
}

func TestIsSupervisedProcessAliveRejectsBarePreservedShell(t *testing.T) {
	entries, err := parseProcessTable("100 1 /bin/zsh -i\n")
	if err != nil {
		t.Fatal(err)
	}
	if containsManagedWorkload(entries, 100, "sess-1", "launch-2") {
		t.Fatal("bare preserved shell was accepted as a live workload")
	}
}

func TestIsSupervisedProcessAliveRejectsInvalidPanePID(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("not-a-pid\n")}

	if _, err := r.IsSupervisedProcessAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.SupervisedProcessRef{}); err == nil {
		t.Fatal("invalid pane pid should remain an inconclusive probe error")
	}
}

// Destroy must reap the pane sessions it discovered so a worker's backgrounded
// dev servers do not outlive the session.
func TestDestroyReapsDiscoveredPaneSessions(t *testing.T) {
	r, fr := newTestRuntime(0)
	// list-panes lists two pane pids (one per line, plus noise the parser must
	// drop); kill-session then succeeds.
	fr.outputs = [][]byte{[]byte("4242\n4243\n\n1\n"), nil}
	reaper := &recordingReaper{}
	r.reapSessions = reaper.reap

	if err := r.Destroy(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	if len(reaper.pids) != 1 {
		t.Fatalf("reaper called %d times, want 1", len(reaper.pids))
	}
	// pids <= 1 and blank lines are dropped; the real sids reach the reaper.
	if got, want := reaper.pids[0], []int{4242, 4243}; !reflect.DeepEqual(got, want) {
		t.Fatalf("reaped session ids = %#v, want %#v", got, want)
	}
	if reaper.graces[0] != r.reapGrace {
		t.Fatalf("reap grace = %v, want %v", reaper.graces[0], r.reapGrace)
	}
}

// -- IsAlive tests --

func TestIsAliveReturnsTrueOnExitZero(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if !alive {
		t.Fatal("alive = false, want true")
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("has-session args = %#v, want %#v", got, want)
	}
}

func TestIsAliveReturnsFalseNilOnCantFindSession(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("can't find session: sess-1")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

// A conclusively absent server means the tmux runtime handle is gone, although
// the agent may still be alive as an orphan. Surface the infrastructure-level
// sentinel rather than a per-session false result: the reaper treats errors as
// failed probes, while explicit recovery paths may recreate the missing server.
func TestIsAliveReportsNoServerAsRuntimeUnavailable(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("no server running on /tmp/tmux-1000/default")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeUnavailable) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeUnavailable", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

func TestIsAliveReportsErrorConnectingAsProbeInconclusive(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("error connecting to /tmp/tmux-1000/default (No such file or directory)")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive err = %v, want ports.ErrRuntimeProbeInconclusive", err)
	}
	if alive {
		t.Fatal("alive = true, want false")
	}
}

// IsAlive must treat any non-"missing" non-zero exit as a probe error so the
// reaper never reads a transient failure as proof of death.
func TestIsAliveReportsOtherExitFailuresAsProbeErrors(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("unexpected internal error")}
	fr.err = &exec.ExitError{}

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if err == nil {
		t.Fatal("IsAlive: got nil, want probe error; failed probe must not read as dead")
	}
	if alive {
		t.Fatal("alive = true on probe failure")
	}
}

// -- SendMessage tests --

func TestSendMessageChunksAndSendsEnter(t *testing.T) {
	r, fr := newTestRuntime(5) // chunkSize=5
	// "hello世界": hello=5 bytes, 世=3 bytes, 界=3 bytes => 3 sends + 1 Enter
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hello世界"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if len(fr.calls) != 4 {
		t.Fatalf("calls = %d, want 4 (3 chunks + Enter)", len(fr.calls))
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), sendKeysLiteralArgs("sess-1", "hello"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 1 args = %#v, want %#v", got, want)
	}
	if got, want := tmuxCommandArgs(fr.calls[1].args), sendKeysLiteralArgs("sess-1", "世"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 2 args = %#v, want %#v", got, want)
	}
	if got, want := tmuxCommandArgs(fr.calls[2].args), sendKeysLiteralArgs("sess-1", "界"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 3 args = %#v, want %#v", got, want)
	}
	if got, want := tmuxCommandArgs(fr.calls[3].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

func TestSendMessageUsesLiteralFlag(t *testing.T) {
	r, fr := newTestRuntime(0)
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "Enter"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	// First call must use -l so "Enter" is sent literally, not as a key binding.
	if args := tmuxCommandArgs(fr.calls[0].args); args[3] != "-l" {
		t.Fatalf("send-keys args[3] = %q, want -l", args[3])
	}
}

// TestSendMessageDelaysBeforeEnter verifies the pre-Enter pause (mirroring
// conpty's ptyInputEnterDelay) fires only for a non-empty message: a large
// multiline paste needs time to settle before the trailing Enter, or the Enter
// is absorbed and the prompt is left unsubmitted (issue #2342). An empty
// (nudge) message skips the pause — there is no paste ahead of a catch-up Enter.
func TestSendMessageDelaysBeforeEnter(t *testing.T) {
	// enterDelay=0 (the test default) => no pause: SendMessage is near-instant.
	r0, _ := newTestRuntime(0)
	r0.enterDelay = 0
	start := time.Now()
	if err := r0.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hi"); err != nil {
		t.Fatalf("SendMessage (no delay): %v", err)
	}
	if dt := time.Since(start); dt > 50*time.Millisecond {
		t.Fatalf("SendMessage with enterDelay=0 took %s; want no real pause", dt)
	}

	// enterDelay>0 => SendMessage blocks at least enterDelay before Enter, but
	// only for a non-empty message.
	r, fr := newTestRuntime(0)
	r.enterDelay = 30 * time.Millisecond
	start = time.Now()
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "hello"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if dt := time.Since(start); dt < r.enterDelay {
		t.Fatalf("SendMessage took %s, want >= %s pre-Enter pause", dt, r.enterDelay)
	}
	// Non-empty message still ends with the literal chunks then Enter.
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want 2 (chunk + Enter)", len(fr.calls))
	}
	if got, want := tmuxCommandArgs(fr.calls[1].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}

	// Empty (nudge) message: no paste, no pause — even with enterDelay set.
	rNudge, frNudge := newTestRuntime(0)
	rNudge.enterDelay = 30 * time.Millisecond
	start = time.Now()
	if err := rNudge.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ""); err != nil {
		t.Fatalf("SendMessage (nudge): %v", err)
	}
	if dt := time.Since(start); dt > 50*time.Millisecond {
		t.Fatalf("nudge SendMessage took %s; want no pause for empty message", dt)
	}
	// Empty message is Enter-only: no send-keys -l call, just Enter.
	if len(frNudge.calls) != 1 {
		t.Fatalf("nudge calls = %d, want 1 (Enter only)", len(frNudge.calls))
	}
	if got, want := tmuxCommandArgs(frNudge.calls[0].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("nudge Enter args = %#v, want %#v", got, want)
	}
}

// TestSendMessageEnterSurvivesCallerCancel pins the detached-Enter contract:
// once the chunks are pasted, a caller cancellation landing in the pre-Enter
// pause must NOT abandon the send — the pasted draft would sit unsubmitted and
// a retried send would double-paste. The pause and Enter run on a context
// detached from the caller's, so SendMessage completes (chunks then Enter).
func TestSendMessageEnterSurvivesCallerCancel(t *testing.T) {
	r, fr := newTestRuntime(0)
	// A pause long enough that the 50ms-delayed cancel deterministically lands
	// inside it (the chunk send is near-instant against the fake runner).
	r.enterDelay = 200 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	timer := time.AfterFunc(50*time.Millisecond, cancel)
	defer timer.Stop()

	if err := r.SendMessage(ctx, ports.RuntimeHandle{ID: "sess-1"}, "hello"); err != nil {
		t.Fatalf("SendMessage cancelled mid-pause: %v (Enter must run detached)", err)
	}
	if len(fr.calls) != 2 {
		t.Fatalf("calls = %d, want 2 (chunk + Enter despite the caller cancel after the paste)", len(fr.calls))
	}
	if got, want := tmuxCommandArgs(fr.calls[1].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

func TestSendMessageRemainingChunksSurviveCallerCancel(t *testing.T) {
	r, fr := newTestRuntime(5)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	secondChunkStarted := make(chan struct{})
	callerCancelled := make(chan struct{})
	go func() {
		<-secondChunkStarted
		cancel()
		close(callerCancelled)
	}()
	fr.hook = func(runCtx context.Context, call int) error {
		if call != 2 {
			return nil
		}
		close(secondChunkStarted)
		<-callerCancelled
		return runCtx.Err()
	}

	if err := r.SendMessage(ctx, ports.RuntimeHandle{ID: "sess-1"}, "helloworld"); err != nil {
		t.Fatalf("SendMessage cancelled after first chunk: %v", err)
	}
	if ctx.Err() != context.Canceled {
		t.Fatalf("caller context error = %v, want context.Canceled", ctx.Err())
	}
	if len(fr.calls) != 3 {
		t.Fatalf("calls = %d, want 3 (two chunks + Enter)", len(fr.calls))
	}
	if got, want := tmuxCommandArgs(fr.calls[1].args), sendKeysLiteralArgs("sess-1", "world"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 2 args = %#v, want %#v", got, want)
	}
	if got, want := tmuxCommandArgs(fr.calls[2].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

func TestSendMessageCompletionBudgetScalesWithChunks(t *testing.T) {
	const commandTimeout = 5 * time.Second
	const enterDelay = 300 * time.Millisecond
	if got, want := sendCompletionBudget(1, commandTimeout, enterDelay), 5*time.Second+enterDelay; got != want {
		t.Fatalf("single-chunk completion budget = %s, want %s", got, want)
	}
	if got, want := sendCompletionBudget(4, commandTimeout, enterDelay), 20*time.Second+enterDelay; got != want {
		t.Fatalf("four-chunk completion budget = %s, want %s", got, want)
	}
}

func TestSendMessageCancellationBeforeFirstChunkAborts(t *testing.T) {
	r, fr := newTestRuntime(5)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	fr.hook = func(runCtx context.Context, _ int) error {
		return runCtx.Err()
	}

	err := r.SendMessage(ctx, ports.RuntimeHandle{ID: "sess-1"}, "helloworld")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("SendMessage error = %v, want context.Canceled", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1 (first chunk attempt only)", len(fr.calls))
	}
}

func TestInterruptSendsCtrlC(t *testing.T) {
	r, fr := newTestRuntime(0)
	if err := r.Interrupt(context.Background(), ports.RuntimeHandle{ID: "sess-1"}); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), sendInterruptArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("interrupt args = %#v, want %#v", got, want)
	}
}

func TestSendInputSendsEscapeWithoutEnter(t *testing.T) {
	r, fr := newTestRuntime(0)
	if err := r.SendInput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "\x1b"); err != nil {
		t.Fatalf("SendInput: %v", err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(fr.calls))
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), sendKeysLiteralArgs("sess-1", "\x1b"); !reflect.DeepEqual(got, want) {
		t.Fatalf("escape args = %#v, want %#v", got, want)
	}
}

// -- GetOutput tests --

func TestGetOutputValidatesLines(t *testing.T) {
	r, _ := newTestRuntime(0)
	_, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 0)
	if err == nil {
		t.Fatal("GetOutput lines=0: got nil, want error")
	}
}

func TestGetOutputTrimsLines(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("one\ntwo\nthree\n")}

	out, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 2)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if out != "two\nthree\n" {
		t.Fatalf("output = %q, want last two lines", out)
	}
}

func TestGetOutputTrimsTrailingScreenPaddingBeforeTailing(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("ready\nprompt> echo hi\nhi\n\n\n\n")}

	out, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 2)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if out != "prompt> echo hi\nhi\n" {
		t.Fatalf("output = %q, want last non-padding lines", out)
	}
}

func TestGetOutputArgs(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("output\n")}

	_, err := r.GetOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 10)
	if err != nil {
		t.Fatalf("GetOutput: %v", err)
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), capturePaneArgs("sess-1", 10); !reflect.DeepEqual(got, want) {
		t.Fatalf("capture-pane args = %#v, want %#v", got, want)
	}
}

func TestGetStyledOutputPreservesCaptureMode(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{[]byte("› \x1b[2mplaceholder\x1b[0m\n")}

	out, err := r.GetStyledOutput(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, 10)
	if err != nil {
		t.Fatalf("GetStyledOutput: %v", err)
	}
	if !strings.Contains(out, "\x1b[2m") {
		t.Fatalf("styled output lost SGR sequence: %q", out)
	}
	if got, want := tmuxCommandArgs(fr.calls[0].args), capturePaneStyledArgs("sess-1", 10); !reflect.DeepEqual(got, want) {
		t.Fatalf("capture-pane args = %#v, want %#v", got, want)
	}
}

// -- AttachCommand tests --

func TestAttachCommandReturnsExpectedArgv(t *testing.T) {
	r := New(Options{Binary: "/usr/bin/tmux", Timeout: time.Second})
	argv, err := r.attachCommand(ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("AttachCommand: %v", err)
	}
	want := []string{"/usr/bin/tmux", "-L", "default", "-u", "-T", "RGB", "attach-session", "-t", "sess-1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandUsesAppOwnedSocket(t *testing.T) {
	r := New(Options{Binary: "/opt/ao/resources/tmux/bin/tmux", SocketName: "ao", Timeout: time.Second})
	argv, err := r.attachCommand(ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("AttachCommand: %v", err)
	}
	want := []string{"/opt/ao/resources/tmux/bin/tmux", "-L", "ao", "-u", "-T", "RGB", "attach-session", "-t", "sess-1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandUsesSystemTmuxForLegacyDefaultSocket(t *testing.T) {
	r := New(Options{
		Binary:       "/opt/ao/resources/tmux/bin/tmux",
		LegacyBinary: "/opt/homebrew/bin/tmux",
		SocketName:   "ao",
		Timeout:      time.Second,
	})
	argv, err := r.attachCommandForSocket("sess-1", r.legacyDefaultSocketTarget())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"/opt/homebrew/bin/tmux", "-L", "default", "-u", "-T", "RGB", "attach-session", "-t", "sess-1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandUsesHistoricalPrivateSocket(t *testing.T) {
	r := New(Options{
		Binary:           "/opt/ao/resources/tmux/bin/tmux",
		SocketName:       "ao",
		LegacySocketPath: "/Users/example/.ao/tmux-legacy.sock",
		Timeout:          time.Second,
	})
	argv, err := r.attachCommandForSocket("sess-1", r.historicalPrivateSocketTarget())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/opt/ao/resources/tmux/bin/tmux",
		"-S", "/Users/example/.ao/tmux-legacy.sock",
		"-f", os.DevNull,
		"-u", "-T", "RGB", "attach-session", "-t", "sess-1",
	}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandRejectsInvalidHandle(t *testing.T) {
	r := New(Options{})
	_, err := r.attachCommand(ports.RuntimeHandle{ID: ""})
	if err == nil {
		t.Fatal("AttachCommand empty handle: got nil, want error")
	}
}

func TestAttachEnvForcesUsableTerm(t *testing.T) {
	env := attachEnv([]string{"PATH=/bin", "TERM=dumb", "COLORTERM=ansi", "SHELL=/bin/sh"})
	if got, want := env, []string{"PATH=/bin", "TERM=xterm-256color", "COLORTERM=truecolor", "SHELL=/bin/sh"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("attachEnv = %#v, want %#v", got, want)
	}

	env = attachEnv([]string{"PATH=/bin"})
	if got, want := env, []string{"PATH=/bin", "TERM=xterm-256color", "COLORTERM=truecolor"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("attachEnv without TERM = %#v, want %#v", got, want)
	}
}

// -- commandError tests --

func TestCommandErrorUnwraps(t *testing.T) {
	base := errors.New("base")
	err := commandError{err: base, output: "details"}
	if !errors.Is(err, base) {
		t.Fatal("commandError should unwrap base error")
	}
	if !strings.Contains(err.Error(), "details") {
		t.Fatalf("error = %q, want output details", err.Error())
	}
}

// -- text helper tests --

func TestChunks(t *testing.T) {
	if got := chunks("", 5); !reflect.DeepEqual(got, []string{""}) {
		t.Fatalf("chunks empty = %#v", got)
	}
	if got := chunks("hello", 10); !reflect.DeepEqual(got, []string{"hello"}) {
		t.Fatalf("chunks fits = %#v", got)
	}
	// UTF-8 boundary: 世 is 3 bytes; with chunkSize=5 "hello世界" splits at 5,6,6
	got := chunks("hello世界", 5)
	if len(got) != 3 {
		t.Fatalf("chunks count = %d, want 3: %#v", len(got), got)
	}
	if got[0] != "hello" || got[1] != "世" || got[2] != "界" {
		t.Fatalf("chunks = %#v, want [hello 世 界]", got)
	}
}

func TestTailLines(t *testing.T) {
	if got := tailLines("a\nb\nc\n", 2); got != "b\nc\n" {
		t.Fatalf("tailLines = %q, want b/c", got)
	}
	if got := tailLines("a\nb\n", 5); got != "a\nb\n" {
		t.Fatalf("tailLines fewer = %q", got)
	}
	if got := tailLines("", 5); got != "" {
		t.Fatalf("tailLines empty = %q", got)
	}
}

func TestTrimTrailingBlankLines(t *testing.T) {
	if got := trimTrailingBlankLines("a\nb\n\n\n"); got != "a\nb\n" {
		t.Fatalf("trimTrailingBlankLines = %q, want a/b", got)
	}
	if got := trimTrailingBlankLines(""); got != "" {
		t.Fatalf("trimTrailingBlankLines empty = %q", got)
	}
}

// -- reap tests --

// The reap used to sleep the whole grace before rechecking, and Destroy blocks
// the shell-terminal DELETE handler, so closing a plain terminal took the full
// 5s no matter how fast the shell exited. Polling must return as soon as the
// pane session is empty.
func TestReapPaneSessionsReturnsAsSoonAsSessionsAreEmpty(t *testing.T) {
	grace := 3 * time.Second
	var signals []string
	calls := 0
	hasProcesses := func(context.Context, []int) bool {
		calls++
		// Alive for the SIGTERM check, gone by the first poll.
		return calls == 1
	}

	start := time.Now()
	reapPaneSessions(context.Background(), []int{4242}, grace,
		func(_ context.Context, _ []int, sig string) bool { signals = append(signals, sig); return true },
		hasProcesses,
	)
	elapsed := time.Since(start)

	if elapsed >= grace {
		t.Fatalf("reap took %v, want well under the %v grace", elapsed, grace)
	}
	if !reflect.DeepEqual(signals, []string{"-TERM"}) {
		t.Fatalf("signals = %#v, want just -TERM: a process that already exited must not be SIGKILLed", signals)
	}
}

// The grace still exists for what it was added for (issue #2523): a dev server
// a worker backgrounded gets the full window to release its ports, and is only
// then forced.
func TestReapPaneSessionsSigkillsSurvivorsAfterGrace(t *testing.T) {
	grace := 150 * time.Millisecond
	var signals []string

	start := time.Now()
	reapPaneSessions(context.Background(), []int{4242}, grace,
		func(_ context.Context, _ []int, sig string) bool { signals = append(signals, sig); return true },
		func(context.Context, []int) bool { return true },
	)
	elapsed := time.Since(start)

	if elapsed < grace {
		t.Fatalf("reap took %v, want at least the %v grace before forcing", elapsed, grace)
	}
	if !reflect.DeepEqual(signals, []string{"-TERM", "-KILL"}) {
		t.Fatalf("signals = %#v, want -TERM then -KILL", signals)
	}
}

// An empty pane list means there is nothing to reap; signalling anything there
// would be pkill against no session at all.
func TestReapPaneSessionsIgnoresEmptyPidList(t *testing.T) {
	called := false
	reapPaneSessions(context.Background(), nil, time.Second,
		func(context.Context, []int, string) bool { called = true; return true },
		func(context.Context, []int) bool { return true },
	)
	if called {
		t.Fatal("no pane sessions should mean no signals sent")
	}
}

// Regression: macOS pkill/pgrep have no `-s` (session id) matcher — it is a
// Linux procps extension — so every signal and probe failed with a usage error
// and the probe's conservative "assume survivors" kept the full grace running.
// The reap accomplished nothing and cost 5s on every close.
func TestReapPaneSessionsSkipsWaitWhenSessionMatcherUnsupported(t *testing.T) {
	grace := 3 * time.Second
	probed := false

	start := time.Now()
	reapPaneSessions(context.Background(), []int{4242}, grace,
		func(context.Context, []int, string) bool { return false },
		func(context.Context, []int) bool { probed = true; return true },
	)
	elapsed := time.Since(start)

	if elapsed >= grace {
		t.Fatalf("reap took %v; a platform that cannot signal by session id must not wait out the grace", elapsed)
	}
	if probed {
		t.Fatal("no point probing for survivors when the matcher itself is unsupported")
	}
}

func TestIsUnsupportedMatcher(t *testing.T) {
	if isUnsupportedMatcher(nil) {
		t.Fatal("a successful match is supported")
	}
	if isUnsupportedMatcher(exitCodeErr(t, 1)) {
		t.Fatal("exit 1 means nothing matched, which is a supported outcome")
	}
	if !isUnsupportedMatcher(exitCodeErr(t, 2)) {
		t.Fatal("exit 2 is a usage error: the matcher is unsupported")
	}
	if !isUnsupportedMatcher(errors.New("exec: \"pkill\": executable file not found")) {
		t.Fatal("a missing pkill is equally unusable")
	}
}

func exitCodeErr(t *testing.T, code int) error {
	t.Helper()
	err := exec.Command("sh", "-c", "exit "+strconv.Itoa(code)).Run()
	if err == nil {
		t.Fatalf("sh -c 'exit %d' should fail", code)
	}
	return err
}

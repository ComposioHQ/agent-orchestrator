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
	env   []string
	stdin []byte
	name  string
	args  []string
}

func (f *fakeRunner) Run(ctx context.Context, env []string, stdin []byte, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{
		env:   append([]string(nil), env...),
		stdin: append([]byte(nil), stdin...),
		name:  name,
		args:  append([]string(nil), args...),
	})
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

var testSocketPath = filepath.Join(os.TempDir(), "ao-tmux-unit-"+strconv.Itoa(os.Getpid()), "s")

func TestMain(m *testing.M) {
	testSocketDir := filepath.Dir(testSocketPath)
	if err := os.MkdirAll(testSocketDir, 0o700); err != nil {
		panic(err)
	}
	resolvedTestSocketDir, err := filepath.EvalSymlinks(testSocketDir)
	if err != nil {
		panic(err)
	}
	testSocketPath = filepath.Join(resolvedTestSocketDir, filepath.Base(testSocketPath))
	code := m.Run()
	_ = os.RemoveAll(testSocketDir)
	os.Exit(code)
}

func newTestRuntime(chunkSize int) (*Runtime, *fakeRunner) {
	fr := &fakeRunner{}
	r := New(Options{
		Binary:     "tmux-test",
		SocketPath: testSocketPath,
		Timeout:    time.Second,
		Shell:      "/bin/sh",
		ChunkSize:  chunkSize,
	})
	r.runner = fr
	r.enterDelay = 0                           // tests must not pay the real 300ms pre-Enter pause
	r.reapSessions = (&recordingReaper{}).reap // never signal real processes from unit tests
	r.syncEnvironment = func(context.Context, string, map[string]string) error { return nil }
	return r, fr
}

// logicalTmuxArgs removes AO's invariant global tmux flags so behavioral tests
// can continue to assert the subcommand interface without brittle positional
// coupling. Dedicated isolation tests below assert the raw -S/-f prefix.
func logicalTmuxArgs(args []string) []string {
	if len(args) >= 4 && args[0] == "-S" && args[2] == "-f" {
		return args[4:]
	}
	return args
}

// countCalls returns how many of fr's recorded calls invoked the given tmux
// subcommand, e.g. "display-message" for pane cwd verification
// probes.
func countCalls(fr *fakeRunner, subcommand string) int {
	n := 0
	for _, c := range fr.calls {
		args := logicalTmuxArgs(c.args)
		if len(args) > 0 && args[0] == subcommand {
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

func TestRunUsesExplicitPrivateSocketAndEmptyConfig(t *testing.T) {
	r := New(Options{Binary: "tmux-test", SocketPath: testSocketPath})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got, want := fr.calls[0].args, []string{"-S", testSocketPath, "-f", os.DevNull, "list-sessions"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %#v, want %#v", got, want)
	}
}

func TestRunFailsClosedWithoutPrivateSocket(t *testing.T) {
	r := New(Options{Binary: "tmux-test"})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err == nil || !strings.Contains(err.Error(), "private socket path is required") {
		t.Fatalf("run error = %v, want missing private socket", err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner calls = %#v, want none", fr.calls)
	}
}

func TestRunFailsClosedWithRelativePrivateSocket(t *testing.T) {
	r := New(Options{Binary: "tmux-test", SocketPath: "relative.sock"})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err == nil || !strings.Contains(err.Error(), "private socket path must be absolute") {
		t.Fatalf("run error = %v, want relative private socket rejection", err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner calls = %#v, want none", fr.calls)
	}
}

func TestRunFailsClosedWhenConfiguredTmuxCannotBeResolved(t *testing.T) {
	configured := filepath.Join(t.TempDir(), "missing-tmux")
	t.Setenv("AO_TMUX_BINARY", configured)
	r := New(Options{SocketPath: testSocketPath})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err == nil || !strings.Contains(err.Error(), "resolve tmux binary") {
		t.Fatalf("run error = %v, want binary resolution failure", err)
	}
	if len(fr.calls) != 0 {
		t.Fatalf("runner calls = %#v, want none", fr.calls)
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
	out, err := (execRunner{}).Run(context.Background(), nil, nil, "sh", "-c", "pwd")
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

func TestExecRunnerTreatsProvidedEnvironmentAsComplete(t *testing.T) {
	t.Setenv("AO_EXEC_RUNNER_AMBIENT", "must-not-leak")
	out, err := (execRunner{}).Run(
		context.Background(),
		[]string{"AO_EXEC_RUNNER_EXPLICIT=present"},
		nil,
		"/bin/sh", "-c", `printf '%s|%s' "$AO_EXEC_RUNNER_EXPLICIT" "$AO_EXEC_RUNNER_AMBIENT"`,
	)
	if err != nil {
		t.Fatalf("execRunner.Run: %v", err)
	}
	if got, want := string(out), "present|"; got != want {
		t.Fatalf("execRunner environment = %q, want %q", got, want)
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

	out, err := (execRunner{}).Run(context.Background(), nil, nil, "sh", "-c", "pwd")
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
	// bootstrap new-session, respawn the real command, display-message cwd
	// verification, set-option status/mouse/window-size, and has-session.
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	h, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"echo", "hi"},
		Env:           map[string]string{"AO_SESSION_ID": "sess-1"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if h.ID != qualifiedRuntimeHandle(routePrivate, "sess-1").ID {
		t.Fatalf("handle ID = %q, want qualified private handle", h.ID)
	}
	if len(fr.calls) != 7 {
		t.Fatalf("calls = %d, want 7", len(fr.calls))
	}

	// Call 0: new-session
	if got := logicalTmuxArgs(fr.calls[0].args)[0]; got != "new-session" {
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
	if !strings.Contains(joined, "exec cat >/dev/null") {
		t.Fatalf("new-session did not use the environment-safe bootstrap pane: %v", fr.calls[0].args)
	}

	// Call 1: respawn the real workload after its session environment is ready.
	if got := logicalTmuxArgs(fr.calls[1].args)[0]; got != "respawn-pane" {
		t.Fatalf("call[1] = %q, want respawn-pane", got)
	}

	// Call 2: verify pane cwd.
	if got, want := logicalTmuxArgs(fr.calls[2].args), paneCurrentPathArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[1] = %#v, want %#v", got, want)
	}

	// Call 3: set-option status off (plain target, pane-targeting does not use =).
	if got, want := logicalTmuxArgs(fr.calls[3].args), setStatusOffArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[2] = %#v, want %#v", got, want)
	}

	// Call 4: set-option mouse on (enables wheel-scroll of the pane).
	if got, want := logicalTmuxArgs(fr.calls[4].args), setMouseOnArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[3] = %#v, want %#v", got, want)
	}

	// Call 5: set-option window-size largest (multi-client sizing, see
	// setWindowSizeLargestArgs).
	if got, want := logicalTmuxArgs(fr.calls[5].args), setWindowSizeLargestArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[4] = %#v, want %#v", got, want)
	}

	// Call 6: has-session (IsAlive, uses exact-match target =sess-1).
	if got, want := logicalTmuxArgs(fr.calls[6].args), hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("call[5] = %#v, want %#v", got, want)
	}
}

func TestCreateLaunchCommandContainsKeepAliveShell(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent", "--flag"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// The launch command is the last argument to respawn-pane; new-session runs
	// only the value-free bootstrap command.
	args := fr.calls[1].args
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

func TestCreateLaunchCommandKeepsConfiguredValuesOutOfArgv(t *testing.T) {
	const secret = "configured-project-token"
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{nil, nil, []byte("/tmp/ws\n"), nil, nil, nil, nil}

	_, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
		Env: map[string]string{
			"AO_SESSION_ID": "sess-1",
			"COLORTERM":     "ansi",
			"PROJECT_TOKEN": secret,
			"PATH":          "/custom/bin:/usr/bin",
		},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for _, call := range fr.calls {
		if strings.Contains(strings.Join(call.args, "\x00"), secret) {
			t.Fatalf("configured secret leaked into process argv: %#v", call.args)
		}
	}
	launchArgs := fr.calls[1].args
	launchCmd := launchArgs[len(launchArgs)-1]
	if !strings.Contains(launchCmd, "unset NO_COLOR;") || !strings.Contains(launchCmd, "export COLORTERM='truecolor';") {
		t.Fatalf("launch command lost constant terminal policy: %q", launchCmd)
	}
}

func TestBuildLaunchCommandPreservesExplicitNoColor(t *testing.T) {
	launchCmd := buildLaunchCommand(ports.RuntimeConfig{
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
		Env:           map[string]string{"NO_COLOR": "1"},
	})

	if strings.Contains(launchCmd, "unset NO_COLOR;") {
		t.Fatalf("launch command unsets configured NO_COLOR: %q", launchCmd)
	}
	if !strings.Contains(launchCmd, "export COLORTERM='truecolor';") {
		t.Fatalf("launch command does not advertise true color: %q", launchCmd)
	}
}

func TestCreateDestroysAndReturnsErrorWhenPaneCWDDoesNotMatch(t *testing.T) {
	r, fr := newTestRuntime(0)
	// new-session and respawn, then a stale pane cwd on every one of the
	// paneCwdVerifyAttempts retries: the pane never settles on the workspace, so
	// Create must exhaust all attempts and fail with the typed mismatch error.
	fr.outputs = [][]byte{nil, nil}
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
	// new-session and respawn, then a stale sample, then a matching sample.
	fr.outputs = [][]byte{nil, nil, []byte("/deleted/shipit\n"), []byte("/tmp/ws\n"), nil, nil, nil}

	h, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"myagent"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if h.ID != qualifiedRuntimeHandle(routePrivate, "sess-1").ID {
		t.Fatalf("handle ID = %q, want qualified private handle", h.ID)
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
		args := logicalTmuxArgs(c.args)
		if len(args) > 0 && args[0] == "has-session" {
			sawHasSession = true
		}
	}
	if !sawHasSession {
		t.Fatal("Create never reached the has-session liveness probe")
	}
	// Verify Destroy was called (kill-session).
	hasKill := false
	for _, c := range fr3.calls {
		args := logicalTmuxArgs(c.args)
		if len(args) > 0 && args[0] == "kill-session" {
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

func (f *fakeRunnerSelectiveErr) Run(_ context.Context, env []string, stdin []byte, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), stdin: append([]byte(nil), stdin...), name: name, args: append([]string(nil), args...)})
	logical := logicalTmuxArgs(args)
	if len(logical) > 0 && logical[0] == f.exitErrOn {
		return f.errOutput, &exec.ExitError{}
	}
	if len(logical) > 0 && logical[0] == "display-message" {
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

func (f *fakeRunnerSequence) Run(_ context.Context, env []string, stdin []byte, name string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, runnerCall{env: append([]string(nil), env...), stdin: append([]byte(nil), stdin...), name: name, args: append([]string(nil), args...)})
	idx := len(f.calls) - 1
	if idx >= len(f.results) {
		idx = len(f.results) - 1
	}
	res := f.results[idx]
	return res.out, res.err
}

func TestRestartRespawnsExistingPaneAndPreservesHandle(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{
		[]byte("100\n"),
		[]byte("100 1 /bin/sh\n"),
		nil,
		nil,
	}
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
	wantHandle := qualifiedRuntimeHandle(routePrivate, "sess-1")
	if got != wantHandle {
		t.Fatalf("Restart handle = %+v, want %+v", got, wantHandle)
	}
	if len(fr.calls) != 4 {
		t.Fatalf("calls = %d, want ownership probe + respawn + liveness probe", len(fr.calls))
	}
	if args := logicalTmuxArgs(fr.calls[2].args); len(args) < 6 || args[0] != "respawn-pane" || args[1] != "-k" || args[3] != "sess-1:0.0" || args[5] != "/tmp/ws" {
		t.Fatalf("respawn args = %#v", args)
	}
	if args := logicalTmuxArgs(fr.calls[3].args); !reflect.DeepEqual(args, hasSessionArgs("sess-1")) {
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

func TestRestartRefusesLiveSupervisorRegardlessOfDurableGeneration(t *testing.T) {
	r, fr := newTestRuntime(0)
	fr.outputs = [][]byte{
		[]byte("100\n"),
		[]byte("100 1 /bin/sh\n200 100 /ao agent-process supervise --session sess-1 --launch older-live-launch -- codex\n"),
	}

	_, err := r.Restart(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, ports.RuntimeConfig{
		SessionID:     "sess-1",
		WorkspacePath: "/tmp/ws",
		Argv:          []string{"codex", "resume", "native-1"},
	})
	if !errors.Is(err, ports.ErrRuntimeBusy) {
		t.Fatalf("Restart error = %v, want ErrRuntimeBusy", err)
	}
	if got := countCalls(fr, "respawn-pane"); got != 0 {
		t.Fatalf("respawn calls = %d, want none while a supervisor is alive", got)
	}
}

func TestIsAliveNeverProbesDefaultSocketWhenLegacyAdoptionIsDisabled(t *testing.T) {
	r := New(Options{Binary: "tmux-test", SocketPath: testSocketPath, Timeout: time.Second})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{{
		out: []byte("can't find session: sess-1"), err: &exec.ExitError{},
	}}}
	r.runner = fr
	handle := ports.RuntimeHandle{ID: "sess-1"}

	alive, err := r.IsAlive(context.Background(), handle)
	if err != nil || alive {
		t.Fatalf("IsAlive = (%v, %v), want (false, nil)", alive, err)
	}
	if len(fr.calls) != 1 {
		t.Fatalf("calls = %d, want one private-socket probe: %+v", len(fr.calls), fr.calls)
	}
	want := append([]string{"-S", testSocketPath, "-f", os.DevNull}, hasSessionArgs("sess-1")...)
	if !reflect.DeepEqual(fr.calls[0].args, want) {
		t.Fatalf("args = %#v, want %#v", fr.calls[0].args, want)
	}
}

func legacyOwnedPaneCommand(runFile, sessionID, launchID string) string {
	return `/bin/zsh -c "cd '/tmp/worktree' || exit; ` +
		"export AO_RUN_FILE=" + shellQuote(runFile) + "; " +
		"export AO_SESSION_ID=" + shellQuote(sessionID) + "; " +
		"export AO_SUPERVISED_PROCESS='1'; " +
		"'/Applications/Agent Orchestrator.app/Contents/Resources/daemon/ao' 'agent-process' 'supervise' " +
		"'--session' " + shellQuote(sessionID) + " '--launch' " + shellQuote(launchID) + " '--' 'codex'" + `"`
}

func TestIsAliveAdoptsOwnershipVerifiedLegacyDefaultSession(t *testing.T) {
	const (
		runFile  = "/tmp/ao/running.json"
		session  = "sess-1"
		launchID = "legacy-launch"
	)
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: " + session), err: &exec.ExitError{}},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, launchID) + "\n")},
		{out: []byte("can't find session: " + session), err: &exec.ExitError{}},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, launchID) + "\n")},
		{},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n200 100 /ao agent-process supervise --session sess-1 --launch legacy-launch -- codex\n201 200 codex\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: session})
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want (true, nil)", alive, err)
	}
	identity, err := r.InspectRuntimeIdentity(context.Background(), ports.RuntimeHandle{ID: session}, session)
	if err != nil || !identity.Legacy || !identity.WorkloadAlive || identity.HandleID != qualifiedRuntimeHandle(routeLegacyDefault, session).ID || identity.LaunchID != launchID {
		t.Fatalf("identity = (%+v, %v), want legacy launch %q", identity, err, launchID)
	}
	if len(fr.calls) != 11 {
		t.Fatalf("calls = %d, want two three-namespace scans plus final probe", len(fr.calls))
	}
	if fr.calls[0].name != "bundled-tmux" || fr.calls[1].name != "bundled-tmux" || fr.calls[2].name != "system-tmux" || fr.calls[8].name != "system-tmux" {
		t.Fatalf("client routing = %#v", fr.calls)
	}
	for _, call := range []runnerCall{fr.calls[2], fr.calls[3], fr.calls[6], fr.calls[7], fr.calls[8]} {
		if len(call.args) < 4 || !reflect.DeepEqual(call.args[:4], []string{"-L", "default", "-f", os.DevNull}) {
			t.Fatalf("legacy args = %#v, want explicit default socket and empty config", call.args)
		}
	}
}

func TestIsAliveAdoptsOwnershipVerifiedLegacyNamedSession(t *testing.T) {
	const (
		runFile  = "/tmp/ao/running.json"
		session  = "sess-1"
		launchID = "named-launch"
	)
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	absentPrivate := fakeRunnerResult{out: []byte("error connecting to private socket (No such file or directory)"), err: &exec.ExitError{}}
	absentDefault := fakeRunnerResult{out: []byte("no server running on default"), err: &exec.ExitError{}}
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		absentPrivate,
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, launchID) + "\n")},
		absentDefault,
		absentPrivate,
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, launchID) + "\n")},
		absentDefault,
		{},
		{out: []byte("100\n")},
		{out: []byte("100 1 /bin/sh\n200 100 /ao agent-process supervise --session sess-1 --launch named-launch -- codex\n201 200 codex\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: session})
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want named runtime alive", alive, err)
	}
	identity, err := r.InspectRuntimeIdentity(context.Background(), ports.RuntimeHandle{ID: session}, session)
	if err != nil || !identity.WorkloadAlive || identity.HandleID != qualifiedRuntimeHandle(routeLegacyNamed, session).ID || identity.LaunchID != launchID {
		t.Fatalf("identity = (%+v, %v), want qualified named launch", identity, err)
	}
	for _, index := range []int{1, 2, 5, 6, 8} {
		call := fr.calls[index]
		if call.name != "bundled-tmux" || len(call.args) < 4 || !reflect.DeepEqual(call.args[:4], []string{"-L", legacyNamedSocket, "-f", os.DevNull}) {
			t.Fatalf("named call[%d] = %s %#v", index, call.name, call.args)
		}
	}
}

func TestQualifiedNamedHandleSkipsCrossNamespaceDiscovery(t *testing.T) {
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  "/tmp/ao/running.json",
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{{}}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), qualifiedRuntimeHandle(routeLegacyNamed, "sess-1"))
	if err != nil || !alive {
		t.Fatalf("IsAlive = (%v, %v), want true", alive, err)
	}
	if len(fr.calls) != 1 || fr.calls[0].name != "bundled-tmux" || !reflect.DeepEqual(fr.calls[0].args[:4], []string{"-L", legacyNamedSocket, "-f", os.DevNull}) {
		t.Fatalf("qualified route calls = %#v, want one named-socket probe", fr.calls)
	}
}

func TestIsAliveRejectsSameNamedForeignLegacySession(t *testing.T) {
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  "/tmp/ao/running.json",
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: sess-1"), err: &exec.ExitError{}},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte("/bin/zsh -c 'exec user-shell'\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if alive || !errors.Is(err, ports.ErrRuntimeProbeInconclusive) {
		t.Fatalf("IsAlive = (%v, %v), want inconclusive foreign collision", alive, err)
	}
}

func TestIsAliveRejectsMultipleOwnedNamespaces(t *testing.T) {
	const runFile = "/tmp/ao/running.json"
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, "sess-1", "private-launch") + "\n")},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, "sess-1", "default-launch") + "\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "sess-1"})
	if alive || !errors.Is(err, ports.ErrRuntimeAmbiguous) {
		t.Fatalf("IsAlive = (%v, %v), want ambiguous owned namespaces", alive, err)
	}
}

func TestPrivateSessionAppearingDuringLegacyInspectionFailsClosed(t *testing.T) {
	const (
		runFile = "/tmp/ao/running.json"
		session = "sess-1"
	)
	r := New(Options{
		Binary:       "bundled-tmux",
		LegacyBinary: "system-tmux",
		SocketPath:   testSocketPath,
		RunFilePath:  runFile,
		Timeout:      time.Second,
	})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{
		{out: []byte("can't find session: " + session), err: &exec.ExitError{}},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, "legacy-launch") + "\n")},
		{}, // A private session appeared before adoption was committed.
		{out: []byte(legacyOwnedPaneCommand(runFile, session, "private-launch") + "\n")},
		{out: []byte("error connecting to named socket (No such file or directory)"), err: &exec.ExitError{}},
		{},
		{out: []byte(legacyOwnedPaneCommand(runFile, session, "legacy-launch") + "\n")},
	}}
	r.runner = fr

	alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: session})
	if alive || !errors.Is(err, ports.ErrRuntimeAmbiguous) {
		t.Fatalf("IsAlive = (%v, %v), want ambiguity after concurrent private appearance", alive, err)
	}
}

func TestLegacyPaneIdentityRequiresExactRunFileAndSupervisor(t *testing.T) {
	command := legacyOwnedPaneCommand("/tmp/ao/running.json", "sess-1", "launch-1")
	if launchID, ok := legacyPaneIdentity(command, "sess-1", "/tmp/ao/running.json"); !ok || launchID != "launch-1" {
		t.Fatalf("legacyPaneIdentity = (%q, %v), want launch-1, true", launchID, ok)
	}
	if _, ok := legacyPaneIdentity(command, "sess-1", "/tmp/other/running.json"); ok {
		t.Fatal("pane with another AO run-file identity was accepted")
	}
	if _, ok := legacyPaneIdentity(strings.Replace(command, "'agent-process'", "'other-process'", 1), "sess-1", "/tmp/ao/running.json"); ok {
		t.Fatal("pane without the AO supervisor was accepted")
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
	if len(fr.calls) != 2 || logicalTmuxArgs(fr.calls[0].args)[0] != "list-panes" || logicalTmuxArgs(fr.calls[1].args)[0] != "kill-session" {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), listPanePIDsArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("list-panes args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[1].args), killSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), hasSessionArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), sendKeysLiteralArgs("sess-1", "hello"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 1 args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[1].args), sendKeysLiteralArgs("sess-1", "世"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 2 args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[2].args), sendKeysLiteralArgs("sess-1", "界"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 3 args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[3].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("Enter args = %#v, want %#v", got, want)
	}
}

func TestSendMessageUsesLiteralFlag(t *testing.T) {
	r, fr := newTestRuntime(0)
	if err := r.SendMessage(context.Background(), ports.RuntimeHandle{ID: "sess-1"}, "Enter"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	// First call must use -l so "Enter" is sent literally, not as a key binding.
	args := logicalTmuxArgs(fr.calls[0].args)
	if args[3] != "-l" {
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
	if got, want := logicalTmuxArgs(fr.calls[1].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(frNudge.calls[0].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[1].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[1].args), sendKeysLiteralArgs("sess-1", "world"); !reflect.DeepEqual(got, want) {
		t.Fatalf("chunk 2 args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[2].args), sendEnterArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), sendInterruptArgs("sess-1"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), sendKeysLiteralArgs("sess-1", "\x1b"); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), capturePaneArgs("sess-1", 10); !reflect.DeepEqual(got, want) {
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
	if got, want := logicalTmuxArgs(fr.calls[0].args), capturePaneStyledArgs("sess-1", 10); !reflect.DeepEqual(got, want) {
		t.Fatalf("capture-pane args = %#v, want %#v", got, want)
	}
}

// -- AttachCommand tests --

func TestAttachCommandReturnsExpectedArgv(t *testing.T) {
	r := New(Options{Binary: "/usr/bin/tmux", SocketPath: testSocketPath, Timeout: time.Second})
	argv, err := r.attachCommand(ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("AttachCommand: %v", err)
	}
	want := []string{"/usr/bin/tmux", "-S", testSocketPath, "-f", os.DevNull, "-u", "-T", "RGB", "attach-session", "-t", "sess-1"}
	if !reflect.DeepEqual(argv, want) {
		t.Fatalf("argv = %#v, want %#v", argv, want)
	}
}

func TestAttachCommandUsesBundledBinaryWithPrivateSocket(t *testing.T) {
	r := New(Options{Binary: "/opt/ao/resources/tmux/bin/tmux", SocketPath: testSocketPath, Timeout: time.Second})
	argv, err := r.attachCommand(ports.RuntimeHandle{ID: "sess-1"})
	if err != nil {
		t.Fatalf("AttachCommand: %v", err)
	}
	want := []string{"/opt/ao/resources/tmux/bin/tmux", "-S", testSocketPath, "-f", os.DevNull, "-u", "-T", "RGB", "attach-session", "-t", "sess-1"}
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

func TestControlEnvIsolatesTmuxAndPreservesWorkloadEnvironment(t *testing.T) {
	base := []string{
		"PATH=/custom/bin:/usr/bin",
		"HOME=/home/me",
		"OPENAI_API_KEY=credential",
		"LANG=en_US.UTF-8",
		"SHELL=/bin/zsh",
		"TERM=dumb",
		"COLORTERM=ansi",
		"TMUX=/tmp/tmux-user/default,1,0",
		"TMUX_PANE=%7",
		"TMUX_TMPDIR=/tmp/user-tmux",
		"TERMINFO=/home/me/.terminfo",
		"TERMINFO_DIRS=/custom/terminfo",
		"AO_TMUX_BINARY=/opt/ao/tmux",
		"AO_TMUX_SOCKET_NAME=ao",
	}
	want := []string{
		"PATH=/custom/bin:/usr/bin",
		"HOME=/home/me",
		"OPENAI_API_KEY=credential",
		"LANG=en_US.UTF-8",
		"SHELL=/bin/zsh",
		"TMUX_TMPDIR=/tmp/user-tmux",
		"TERMINFO=/home/me/.terminfo",
		"TERMINFO_DIRS=/custom/terminfo",
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	}
	if got := controlEnv(base); !reflect.DeepEqual(got, want) {
		t.Fatalf("controlEnv = %#v, want %#v", got, want)
	}
}

func TestRunPassesCompleteSanitizedControlEnvironment(t *testing.T) {
	t.Setenv("TMUX", "/tmp/tmux-user/default,1,0")
	t.Setenv("TMUX_TMPDIR", "/tmp/user-tmux")
	t.Setenv("TERMINFO", "/home/me/.terminfo")
	t.Setenv("AO_TMUX_BINARY", "/opt/ao/tmux")
	t.Setenv("AO_CONTROL_ENV_SENTINEL", "preserved")
	r := New(Options{Binary: "tmux-test", SocketPath: testSocketPath})
	fr := &fakeRunner{}
	r.runner = fr

	if _, err := r.run(context.Background(), "list-sessions"); err != nil {
		t.Fatal(err)
	}
	if len(fr.calls) != 1 || fr.calls[0].env == nil {
		t.Fatalf("runner calls = %#v, want one call with a complete environment", fr.calls)
	}
	got := make(map[string]string)
	for _, kv := range fr.calls[0].env {
		key, value, ok := strings.Cut(kv, "=")
		if ok {
			got[key] = value
		}
	}
	for _, key := range []string{"TMUX", "AO_TMUX_BINARY"} {
		if _, ok := got[key]; ok {
			t.Errorf("control environment retained %s", key)
		}
	}
	if got["AO_CONTROL_ENV_SENTINEL"] != "preserved" || got["TMUX_TMPDIR"] != "/tmp/user-tmux" || got["TERMINFO"] != "/home/me/.terminfo" || got["TERM"] != "xterm-256color" || got["COLORTERM"] != "truecolor" {
		t.Fatalf("control environment lost required values: sentinel=%q TMUX_TMPDIR=%q TERMINFO=%q TERM=%q COLORTERM=%q", got["AO_CONTROL_ENV_SENTINEL"], got["TMUX_TMPDIR"], got["TERMINFO"], got["TERM"], got["COLORTERM"])
	}
}

func TestEnvironmentSyncUsesStdinAndRemovesStaleNames(t *testing.T) {
	const secret = "credential with spaces\n$and-quotes\""
	r := New(Options{Binary: "tmux-test", SocketPath: testSocketPath, Timeout: time.Second})
	fr := &fakeRunner{outputs: [][]byte{
		[]byte("GLOBAL_STALE_TOKEN=old\nTERM=screen-256color\n"),
		[]byte("SESSION_STALE_TOKEN=old\n"),
	}}
	r.runner = fr

	if err := r.syncCurrentEnvironment(context.Background(), "sess-1", map[string]string{"AO_TMUX_SYNC_SECRET": secret}); err != nil {
		t.Fatalf("syncCurrentEnvironment: %v", err)
	}
	if len(fr.calls) != 3 {
		t.Fatalf("calls = %d, want global/session show-environment then source-file", len(fr.calls))
	}
	if got, want := logicalTmuxArgs(fr.calls[0].args), []string{"show-environment", "-g"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("inspect args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[1].args), []string{"show-environment", "-t", "=sess-1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("inspect args = %#v, want %#v", got, want)
	}
	if got, want := logicalTmuxArgs(fr.calls[2].args), []string{"source-file", "-"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("apply args = %#v, want %#v", got, want)
	}
	for _, call := range fr.calls {
		if strings.Contains(strings.Join(call.args, "\x00"), secret) {
			t.Fatalf("secret leaked into argv: %#v", call.args)
		}
	}
	script := string(fr.calls[2].stdin)
	if script == "" {
		t.Fatal("source-file stdin is empty")
	}
	if strings.Contains(script, secret) {
		t.Fatal("source-file input retained the unencoded secret")
	}
	if !strings.Contains(script, "set-environment -t =sess-1 AO_TMUX_SYNC_SECRET ") {
		t.Fatalf("source script did not refresh the current key: %q", script)
	}
	for _, staleKey := range []string{"GLOBAL_STALE_TOKEN", "SESSION_STALE_TOKEN"} {
		if !strings.Contains(script, "set-environment -r -t =sess-1 "+staleKey+"\n") {
			t.Fatalf("source script did not remove stale key %s from the restarted session: %q", staleKey, script)
		}
	}
	if strings.Contains(script, "set-environment -r -t =sess-1 TERM") {
		t.Fatalf("source script must leave tmux-owned TERM alone: %q", script)
	}
}

func TestEnvironmentSyncConfigEncodingAndParsing(t *testing.T) {
	if got, want := tmuxConfigQuote("a\n$\"é"), `"\141\012\044\042\303\251"`; got != want {
		t.Fatalf("tmuxConfigQuote = %q, want %q", got, want)
	}
	if got, want := parseTmuxEnvironmentNames("B=two\n-A\nTERM=screen\nBAD-KEY=x\nC=three=four\n"), []string{"A", "B", "C"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("parseTmuxEnvironmentNames = %#v, want %#v", got, want)
	}
}

func TestEnvironmentSyncRejectsMissingSessionServer(t *testing.T) {
	serverMissing := fakeRunnerResult{out: []byte("no server running on private socket"), err: &exec.ExitError{}}
	r := New(Options{Binary: "tmux-test", SocketPath: testSocketPath, Timeout: time.Second})
	fr := &fakeRunnerSequence{results: []fakeRunnerResult{serverMissing}}
	r.runner = fr
	if err := r.syncCurrentEnvironment(context.Background(), "sess-1", nil); err == nil || !strings.Contains(err.Error(), "server unavailable") {
		t.Fatalf("restart sync error = %v, want unavailable server", err)
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

package tmux

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestRuntimeIntegration(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := strings.ReplaceAll(t.Name(), "/", "_")
	r := New(Options{
		SocketPath: integrationSocketPath(t),
		Timeout:    5 * time.Second,
	})

	// Ensure clean slate: ignore errors (session may not exist).
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: id})

	t.Cleanup(func() {
		// Always destroy so a test failure never leaks a tmux session.
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: id})
	})

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: t.TempDir(),
		// Run a trivial command then drop into an interactive shell (the keep-alive
		// exec is added by buildLaunchCommand, but we also verify here that output
		// appears).
		Argv: []string{"sh", "-c", "echo hello-from-tmux"},
		Env:  map[string]string{"AO_SESSION_ID": id},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	alive, err := r.IsAlive(ctx, h)
	if err != nil {
		t.Fatalf("IsAlive: %v", err)
	}
	if !alive {
		t.Fatal("alive = false, want true after create")
	}

	// Wait for the echo output to appear (the session may take a moment to
	// write it to the pane history).
	out := waitForOutput(t, r, h, "hello-from-tmux", 5*time.Second)
	if !strings.Contains(out, "hello-from-tmux") {
		t.Fatalf("output = %q, want hello-from-tmux", out)
	}

	// Send a command and verify it echoes back.
	if err := r.SendMessage(ctx, h, "echo hello-send"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	out = waitForOutput(t, r, h, "hello-send", 5*time.Second)
	if !strings.Contains(out, "hello-send") {
		t.Fatalf("output after SendMessage = %q, want hello-send", out)
	}

	// Destroy and verify liveness goes false. When this was the server's last
	// session the server itself exits with it, and the probe reports the
	// server-level outage as ErrRuntimeUnavailable rather than a per-session
	// false result (issue #3475); both outcomes mean the tmux handle is gone.
	if err := r.Destroy(ctx, h); err != nil {
		t.Fatalf("Destroy: %v", err)
	}
	alive, err = r.IsAlive(ctx, h)
	if err != nil && !errors.Is(err, ports.ErrRuntimeUnavailable) {
		t.Fatalf("IsAlive after destroy: %v", err)
	}
	if alive {
		t.Fatal("alive after destroy = true, want false")
	}
}

// TestRuntimeIntegrationExactSessionParsing verifies that IsAlive uses exact
// session matching and does not treat a prefix as a live session.
func TestRuntimeIntegrationExactSessionParsing(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	base := strings.ReplaceAll(t.Name(), "/", "_")
	longID := base + "_long"
	prefixID := base

	r := New(Options{
		SocketPath: integrationSocketPath(t),
		Timeout:    5 * time.Second,
	})
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: longID})
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: prefixID})

	t.Cleanup(func() {
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: longID})
		_ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: prefixID})
	})

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(longID),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"sh", "-c", "echo ready"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// tmux has-session -t <prefix> should NOT match <longID> because tmux
	// requires the exact session name when using -t with a plain string (not a
	// glob). Verify by probing the prefix handle directly.
	prefixAlive, err := r.IsAlive(ctx, ports.RuntimeHandle{ID: prefixID})
	if err != nil {
		// tmux may return an error (session not found) rather than exit 0.
		// That is acceptable here: the point is the prefix must not be alive.
		t.Logf("IsAlive prefix returned error (acceptable): %v", err)
	}
	if prefixAlive {
		_ = r.Destroy(ctx, h)
		t.Fatal("prefix handle reported alive; tmux session matching is not exact")
	}
}

func TestRuntimeIntegrationSupervisedExitKeepsInteractiveShell(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}

	ctx := context.Background()
	id := strings.ReplaceAll(t.Name(), "/", "_")
	const launchID = "launch-1"
	r := New(Options{
		SocketPath: integrationSocketPath(t),
		Timeout:    5 * time.Second,
	})
	tmuxID := SessionName(id)
	workspace := t.TempDir()
	_ = r.Destroy(ctx, ports.RuntimeHandle{ID: tmuxID})
	t.Cleanup(func() { _ = r.Destroy(context.Background(), ports.RuntimeHandle{ID: tmuxID}) })

	// Re-run this test binary as a long-lived helper with the same controlled
	// command-line identity as AO's supervisor. The CLI package separately tests
	// that the real supervisor waits for and reports its child.
	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{os.Args[0], "-test.run=TestSupervisorProcessHelper", "--", "agent-process", "supervise", "--session", id, "--launch", launchID, "--"},
		Env:           map[string]string{"AO_TMUX_SUPERVISOR_HELPER": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ref := ports.SupervisedProcessRef{SessionID: domain.SessionID(id), LaunchID: launchID}
	deadline := time.Now().Add(10 * time.Second)
	for {
		alive, probeErr := r.IsSupervisedProcessAlive(ctx, h, ref)
		if probeErr != nil {
			t.Fatal(probeErr)
		}
		if alive {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervised workload did not appear in the tmux process tree")
		}
		time.Sleep(100 * time.Millisecond)
	}

	// The helper exits normally, matching Codex /exit or EOF. The launch shell
	// must then execute AO's keep-alive interactive shell.
	deadline = time.Now().Add(10 * time.Second)
	for {
		alive, probeErr := r.IsSupervisedProcessAlive(ctx, h, ref)
		if probeErr != nil {
			t.Fatal(probeErr)
		}
		if !alive {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("supervised workload remained alive after normal exit")
		}
		time.Sleep(100 * time.Millisecond)
	}
	if alive, err := r.IsAlive(ctx, h); err != nil || !alive {
		t.Fatalf("tmux after workload exit = (%v, %v), want (true, nil)", alive, err)
	}
	if err := r.SendMessage(ctx, h, "echo shell-after-agent-exit"); err != nil {
		t.Fatal(err)
	}
	out := waitForOutput(t, r, h, "shell-after-agent-exit", 5*time.Second)
	if !strings.Contains(out, "shell-after-agent-exit") {
		t.Fatalf("post-exit shell output = %q", out)
	}

	restarted, err := r.Restart(ctx, h, ports.RuntimeConfig{
		SessionID:     domain.SessionID(id),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo managed-agent-resumed"},
	})
	if err != nil {
		t.Fatalf("Restart: %v", err)
	}
	if restarted != h {
		t.Fatalf("restart handle = %+v, want existing handle %+v", restarted, h)
	}
	out = waitForOutput(t, r, restarted, "managed-agent-resumed", 5*time.Second)
	if !strings.Contains(out, "managed-agent-resumed") {
		t.Fatalf("restart output = %q, want managed-agent-resumed", out)
	}
	if err := r.SendMessage(ctx, restarted, "echo shell-after-managed-resume"); err != nil {
		t.Fatal(err)
	}
	out = waitForOutput(t, r, restarted, "shell-after-managed-resume", 5*time.Second)
	if !strings.Contains(out, "shell-after-managed-resume") {
		t.Fatalf("post-resume shell output = %q", out)
	}
}

func TestRuntimeIntegrationRefreshesEnvironmentOnPersistentServer(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}

	const envKey = "AO_TMUX_ENV_REFRESH_TEST"
	t.Setenv(envKey, "old")
	ctx := context.Background()
	socketPath := integrationSocketPath(t)
	r := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	base := strings.ReplaceAll(t.Name(), "/", "_")
	oldHandle, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(base + "_old"),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", "sleep 10"},
	})
	if err != nil {
		t.Fatalf("create old-environment session: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), oldHandle) })

	// Model an app/daemon restart while the private tmux server survives. A new
	// Runtime object uses the same socket, but the next pane must receive the
	// current daemon environment rather than the server's startup snapshot.
	t.Setenv(envKey, "new")
	restarted := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	newHandle, err := restarted.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(base + "_new"),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", `printf 'env=%s\n' "$` + envKey + `"; sleep 10`},
	})
	if err != nil {
		t.Fatalf("create refreshed-environment session: %v", err)
	}
	t.Cleanup(func() { _ = restarted.Destroy(context.Background(), newHandle) })

	out := waitForOutput(t, restarted, newHandle, "env=new", 5*time.Second)
	if strings.Contains(out, "env=old") {
		t.Fatalf("new session inherited stale server environment: %q", out)
	}

	// Unsetting a variable must remove the value from tmux rather than merely
	// omitting an update and allowing the persistent server's old value through.
	if err := os.Unsetenv(envKey); err != nil {
		t.Fatal(err)
	}
	withoutValue := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	unsetHandle, err := withoutValue.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(base + "_unset"),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", `printf 'env=%s\n' "${` + envKey + `-unset}"; sleep 10`},
	})
	if err != nil {
		t.Fatalf("create unset-environment session: %v", err)
	}
	t.Cleanup(func() { _ = withoutValue.Destroy(context.Background(), unsetHandle) })
	out = waitForOutput(t, withoutValue, unsetHandle, "env=unset", 5*time.Second)
	if strings.Contains(out, "env=old") || strings.Contains(out, "env=new") {
		t.Fatalf("unset variable retained a stale server value: %q", out)
	}

	// Restart must inspect the target session as well as the daemon environment.
	// A session-only value cannot be discovered by looking at the server's global
	// environment, and would otherwise survive respawn-pane.
	const sessionOnlyKey = "AO_TMUX_SESSION_ONLY_STALE_TEST"
	if err := os.Unsetenv(sessionOnlyKey); err != nil {
		t.Fatal(err)
	}
	if _, err := withoutValue.run(ctx, "set-environment", "-t", exactSessionTarget(newHandle.ID), sessionOnlyKey, "stale"); err != nil {
		t.Fatalf("seed session-only stale variable: %v", err)
	}
	if _, err := withoutValue.Restart(ctx, newHandle, ports.RuntimeConfig{
		SessionID:     domain.SessionID(base + "_new"),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", `printf 'session=%s\n' "${` + sessionOnlyKey + `-unset}"; sleep 10`},
	}); err != nil {
		t.Fatalf("restart after session-only variable removal: %v", err)
	}
	out = waitForOutput(t, withoutValue, newHandle, "session=unset", 5*time.Second)
	if strings.Contains(out, "session=stale") {
		t.Fatalf("restart retained a session-only stale value: %q", out)
	}
}

func TestRuntimeIntegrationKeepsConfiguredEnvironmentOutOfPaneArgv(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}

	const (
		envKey = "AO_TMUX_CONFIGURED_SECRET_TEST"
		secret = "configured-secret-must-not-appear-in-argv"
	)
	r := New(Options{SocketPath: integrationSocketPath(t), Timeout: 5 * time.Second})
	handle, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     domain.SessionID(strings.ReplaceAll(t.Name(), "/", "_")),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", `printf 'configured=%s\n' "$` + envKey + `"; sleep 10`},
		Env:           map[string]string{envKey: secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), handle) })
	waitForOutput(t, r, handle, "configured="+secret, 5*time.Second)

	panePID, err := r.run(context.Background(), panePIDArgs(handle.ID)...)
	if err != nil {
		t.Fatalf("inspect pane pid: %v", err)
	}
	argv, err := exec.Command("ps", "-ww", "-p", strings.TrimSpace(string(panePID)), "-o", "command=").Output()
	if err != nil {
		t.Fatalf("inspect pane argv: %v", err)
	}
	if strings.Contains(string(argv), secret) {
		t.Fatalf("configured environment value leaked into pane argv: %q", argv)
	}
}

func TestRuntimeIntegrationUsesAliasForLongPrivateSocket(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}

	targetDir := filepath.Join(t.TempDir(), strings.Repeat("deep-runtime-directory-", 6))
	if err := os.MkdirAll(targetDir, 0o700); err != nil {
		t.Fatal(err)
	}
	socketPath := filepath.Join(targetDir, "tmux-0123456789abcdef0123456789abcdef.sock")
	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatal(err)
	}
	if address == socketPath {
		t.Fatalf("precondition: long socket path was not aliased: %q", socketPath)
	}
	t.Cleanup(func() { _ = os.Remove(filepath.Dir(address)) })

	r := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	handle, err := r.Create(context.Background(), ports.RuntimeConfig{
		SessionID:     domain.SessionID(strings.ReplaceAll(t.Name(), "/", "_")),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", "printf 'alias-ok\\n'; sleep 10"},
	})
	if err != nil {
		t.Fatalf("create through long private socket: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), handle) })
	waitForOutput(t, r, handle, "alias-ok", 5*time.Second)
}

func TestSupervisorProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_SUPERVISOR_HELPER") != "1" {
		return
	}
	time.Sleep(2 * time.Second)
}

func integrationSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ao-tmux-")
	if err != nil {
		t.Fatalf("create private tmux socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "s")
}

// waitForOutput polls GetOutput until out contains want or the deadline passes.
func waitForOutput(t *testing.T, r *Runtime, h ports.RuntimeHandle, want string, deadline time.Duration) string {
	t.Helper()
	end := time.Now().Add(deadline)
	var out string
	for time.Now().Before(end) {
		var err error
		out, err = r.GetOutput(context.Background(), h, 50)
		if err != nil {
			t.Fatalf("GetOutput: %v", err)
		}
		if strings.Contains(out, want) {
			return out
		}
		time.Sleep(100 * time.Millisecond)
	}
	return out
}

// setPrivateServerOption sets a global option on the private tmux server the
// Runtime is using. The server must already exist, so call this after a first
// Create.
//
// `-f /dev/null` in managedArgs only suppresses config-file loading at server
// start; options set explicitly afterwards still take effect. That is what lets
// these tests put the server into a non-default index layout without depending
// on any tmux.conf.
func setPrivateServerOption(t *testing.T, socketPath string, args ...string) {
	t.Helper()
	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatalf("private socket address: %v", err)
	}
	full := append([]string{"-S", address, "-f", os.DevNull}, args...)
	if out, err := exec.Command("tmux", full...).CombinedOutput(); err != nil {
		t.Fatalf("tmux %v: %v: %s", args, err, out)
	}
}

// TestRuntimeIntegrationRestartUnderNonDefaultBaseIndex pins Restart's pane
// target against a server whose base-index and pane-base-index are 1.
//
// Since AO moved to a private socket started with `-f /dev/null`, a user's
// tmux.conf can no longer put the server into this state, so this is hardening
// rather than a live user-facing bug: it keeps the target correct if the
// isolation is ever relaxed, and documents why the target is written the way it
// is. A literal "<id>:0.0" is only correct while something guarantees both
// indices are 0; naming the pane by position does not depend on that guarantee.
func TestRuntimeIntegrationRestartUnderNonDefaultBaseIndex(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	ctx := context.Background()
	socketPath := integrationSocketPath(t)
	r := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	workspace := t.TempDir()

	// A first session brings the private server up so options can be set on it.
	boot, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-baseindex-boot"),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo boot"},
	})
	if err != nil {
		t.Fatalf("Create boot session: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), boot) })

	setPrivateServerOption(t, socketPath, "set-option", "-g", "base-index", "1")
	setPrivateServerOption(t, socketPath, "set-window-option", "-g", "pane-base-index", "1")

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-baseindex-agent"),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo agent-first-run"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), h) })

	// Guard the guard: without base-index 1 actually in force this test would
	// pass while exercising nothing.
	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatalf("private socket address: %v", err)
	}
	out, err := exec.Command("tmux", "-S", address, "-f", os.DevNull,
		"list-windows", "-t", h.ID, "-F", "#{window_index}").CombinedOutput()
	if err != nil {
		t.Fatalf("list-windows: %v: %s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "1" {
		t.Fatalf("window index = %q, want 1 — the server did not adopt base-index 1", got)
	}

	if _, err := r.Restart(ctx, h, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-baseindex-agent"),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo agent-resumed"},
	}); err != nil {
		t.Fatalf("Restart under base-index 1: %v", err)
	}
	if got := waitForOutput(t, r, h, "agent-resumed", 5*time.Second); !strings.Contains(got, "agent-resumed") {
		t.Fatalf("restart output = %q, want agent-resumed", got)
	}
}

// TestRuntimeIntegrationRestartTargetsAgentPaneNotActivePane pins the other half
// of the pane-target contract: it must be deterministic, not merely
// index-independent.
//
// This one is not hypothetical even with the private socket, because it does not
// depend on any tmux option. AO hands the user an ordinary attach client with
// tmux's default prefix key, so they can open a second window inside the session
// at any time. A bare session target follows whatever pane is active, which would
// make Restart's `respawn-pane -k` kill the pane the user is working in and leave
// the real agent pane behind as a corpse that has-session still reports healthy.
func TestRuntimeIntegrationRestartTargetsAgentPaneNotActivePane(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	ctx := context.Background()
	socketPath := integrationSocketPath(t)
	r := New(Options{SocketPath: socketPath, Timeout: 5 * time.Second})
	workspace := t.TempDir()

	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-panetarget"),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo agent-first-run"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), h) })

	address, err := privateSocketAddress(socketPath)
	if err != nil {
		t.Fatalf("private socket address: %v", err)
	}
	panePIDs := func() []string {
		t.Helper()
		out, listErr := exec.Command("tmux", "-S", address, "-f", os.DevNull,
			"list-panes", "-s", "-t", h.ID, "-F", "#{pane_pid}").CombinedOutput()
		if listErr != nil {
			t.Fatalf("list-panes: %v: %s", listErr, out)
		}
		return strings.Fields(string(out))
	}

	before := panePIDs()
	if len(before) != 1 {
		t.Fatalf("panes after Create = %v, want exactly the agent pane", before)
	}
	agentPane := before[0]

	// The user opens a window of their own; it becomes the active one.
	setPrivateServerOption(t, socketPath, "new-window", "-t", h.ID, "sh", "-c", "sleep 120")
	userPanes := panePIDs()
	if len(userPanes) != 2 {
		t.Fatalf("panes after new-window = %v, want the agent pane plus the user's", userPanes)
	}

	if _, err := r.Restart(ctx, h, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-panetarget"),
		WorkspacePath: workspace,
		Argv:          []string{"sh", "-c", "echo agent-resumed"},
	}); err != nil {
		t.Fatalf("Restart: %v", err)
	}

	after := panePIDs()
	if len(after) != 2 {
		t.Fatalf("panes after Restart = %v, want both still present", after)
	}
	for _, pid := range after {
		if pid == agentPane {
			t.Fatalf("agent pane pid %s unchanged after Restart — respawn hit some other pane; panes now %v", agentPane, after)
		}
	}
	userPane := userPanes[1]
	found := false
	for _, pid := range after {
		if pid == userPane {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("user's pane pid %s is gone after Restart — respawn -k killed the wrong pane; panes now %v", userPane, after)
	}
}

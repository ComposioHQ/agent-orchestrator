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
	newSessionID, err := handleID(newHandle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := withoutValue.run(ctx, "set-environment", "-t", exactSessionTarget(newSessionID), sessionOnlyKey, "stale"); err != nil {
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

	sessionID, err := handleID(handle)
	if err != nil {
		t.Fatal(err)
	}
	panePID, err := r.run(context.Background(), panePIDArgs(sessionID)...)
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

// TestRuntimeIntegrationAdoptsLegacyDefaultSocketAcrossPrivateSocketUpgrade
// models the desktop update boundary which moved AO from the system tmux
// default socket to its hashed private socket. The old, ownership-stamped pane
// must remain reachable while every newly-created session stays isolated on
// the private socket.
func TestRuntimeIntegrationAdoptsLegacyDefaultSocketAcrossPrivateSocketUpgrade(t *testing.T) {
	systemTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("tmux not available")
	}

	// Never inspect or mutate the developer's real default server. TMUX_TMPDIR
	// gives this test an isolated server which still exercises tmux's -L default
	// naming path exactly as an upgraded desktop install does.
	legacySocketRoot, err := os.MkdirTemp("", "ao-legacy-")
	if err != nil {
		t.Fatalf("create isolated legacy socket directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(legacySocketRoot) })
	t.Setenv("TMUX_TMPDIR", legacySocketRoot)
	ctx := context.Background()
	runFile := filepath.Join(t.TempDir(), "running.json")
	r := New(Options{
		Binary:       systemTmux,
		LegacyBinary: systemTmux,
		SocketPath:   integrationSocketPath(t),
		RunFilePath:  runFile,
		Timeout:      5 * time.Second,
	})
	base := strings.ReplaceAll(t.Name(), "/", "_")
	legacyID := base + "_legacy"
	privateID := base + "_private"
	const legacyLaunchID = "launch-before-update"

	legacyCommand := "cd " + shellQuote(t.TempDir()) + " || exit; " +
		"export AO_RUN_FILE=" + shellQuote(runFile) + "; " +
		"export AO_SESSION_ID=" + shellQuote(legacyID) + "; " +
		"export AO_SUPERVISED_PROCESS='1'; " +
		"export AO_TMUX_LEGACY_UPGRADE_HELPER='1'; " +
		shellQuote(os.Args[0]) + " '-test.run=TestLegacyUpgradeProcessHelper' '--' " +
		"'agent-process' 'supervise' '--session' " + shellQuote(legacyID) +
		" '--launch' " + shellQuote(legacyLaunchID) + " '--'"
	if out, createErr := r.runOnLegacy(ctx, nil, newSessionArgs(legacyID, t.TempDir(), "/bin/sh", legacyCommand)...); createErr != nil {
		t.Fatalf("create isolated legacy session: %v: %s", createErr, out)
	}
	t.Cleanup(func() {
		_, _ = r.runOnLegacy(context.Background(), nil, killSessionArgs(legacyID)...)
	})

	legacyHandle := ports.RuntimeHandle{ID: legacyID}
	if alive, aliveErr := r.IsAlive(ctx, legacyHandle); aliveErr != nil || !alive {
		t.Fatalf("legacy IsAlive = (%v, %v), want (true, nil)", alive, aliveErr)
	}
	waitForOutput(t, r, legacyHandle, "legacy-upgrade-ready", 5*time.Second)
	identity, err := r.InspectRuntimeIdentity(ctx, legacyHandle, domain.SessionID(legacyID))
	if err != nil || !identity.Legacy || identity.LaunchID != legacyLaunchID {
		t.Fatalf("legacy identity = (%+v, %v), want launch %q", identity, err, legacyLaunchID)
	}
	attachArgv, err := r.attachCommandForRoute(legacyID, routeLegacyDefault)
	if err != nil || len(attachArgv) < 5 || attachArgv[0] != systemTmux || attachArgv[1] != "-L" || attachArgv[2] != "default" {
		t.Fatalf("legacy attach argv = (%#v, %v), want system tmux -L default", attachArgv, err)
	}

	privateHandle, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID(privateID),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"/bin/sh", "-c", "printf 'private-upgrade-ready\\n'; sleep 30"},
	})
	if err != nil {
		t.Fatalf("create private post-update session: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), privateHandle) })
	waitForOutput(t, r, privateHandle, "private-upgrade-ready", 5*time.Second)

	if out, probeErr := r.run(ctx, hasSessionArgs(legacyID)...); probeErr == nil || !sessionMissingOutput(string(out)) {
		t.Fatalf("legacy session unexpectedly exists on private socket: (%q, %v)", out, probeErr)
	}
	if out, probeErr := r.runOnLegacy(ctx, nil, hasSessionArgs(privateID)...); probeErr == nil || !sessionMissingOutput(string(out)) {
		t.Fatalf("new session unexpectedly exists on legacy socket: (%q, %v)", out, probeErr)
	}
}

func TestRuntimeIntegrationRejectsThreeOwnedNamespacesWithoutMutation(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux not available")
	}
	systemTmux, err := exec.LookPath("tmux")
	if err != nil {
		t.Fatal(err)
	}
	socketRoot, err := os.MkdirTemp("", "ao-three-namespace-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketRoot) })
	t.Setenv("TMUX_TMPDIR", socketRoot)

	ctx := context.Background()
	runFile := filepath.Join(t.TempDir(), "running.json")
	r := New(Options{
		Binary:       systemTmux,
		LegacyBinary: systemTmux,
		SocketPath:   integrationSocketPath(t),
		RunFilePath:  runFile,
		Timeout:      5 * time.Second,
	})
	id := strings.ReplaceAll(t.Name(), "/", "_")
	workspace := t.TempDir()
	routes := []sessionRoute{routePrivate, routeLegacyNamed, routeLegacyDefault}
	for _, route := range routes {
		launchID := route.handleName() + "-launch"
		command := "cd " + shellQuote(workspace) + " || exit; " +
			"export AO_RUN_FILE=" + shellQuote(runFile) + "; " +
			"export AO_SESSION_ID=" + shellQuote(id) + "; " +
			"export AO_SUPERVISED_PROCESS='1'; " +
			"export AO_TMUX_AMBIGUITY_HELPER='1'; " +
			shellQuote(os.Args[0]) + " '-test.run=TestAmbiguousRuntimeProcessHelper' '--' " +
			"'agent-process' 'supervise' '--session' " + shellQuote(id) +
			" '--launch' " + shellQuote(launchID) + " '--'"
		if out, createErr := r.runOnRoute(ctx, route, nil, newSessionArgs(id, workspace, "/bin/sh", command)...); createErr != nil {
			t.Fatalf("create %s session: %v: %s", route.handleName(), createErr, out)
		}
		t.Cleanup(func() {
			_, _ = r.runOnRoute(context.Background(), route, nil, killSessionArgs(id)...)
		})
	}

	alive, probeErr := r.IsAlive(ctx, ports.RuntimeHandle{ID: id})
	if alive || !errors.Is(probeErr, ports.ErrRuntimeAmbiguous) {
		t.Fatalf("three-namespace IsAlive = (%v, %v), want ErrRuntimeAmbiguous", alive, probeErr)
	}
	for _, route := range routes {
		if out, checkErr := r.runOnRoute(ctx, route, nil, hasSessionArgs(id)...); checkErr != nil {
			t.Fatalf("%s session was mutated during ambiguity detection: %v: %s", route.handleName(), checkErr, out)
		}
	}
}

func TestSupervisorProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_SUPERVISOR_HELPER") != "1" {
		return
	}
	time.Sleep(2 * time.Second)
}

func TestLegacyUpgradeProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_LEGACY_UPGRADE_HELPER") != "1" {
		return
	}
	_, _ = os.Stdout.WriteString("legacy-upgrade-ready\n")
	time.Sleep(30 * time.Second)
}

func TestAmbiguousRuntimeProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_AMBIGUITY_HELPER") != "1" {
		return
	}
	time.Sleep(30 * time.Second)
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

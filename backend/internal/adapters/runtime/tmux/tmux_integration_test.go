package tmux

import (
	"context"
	"errors"
	"os"
	"os/exec"
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
	r := New(Options{Timeout: 5 * time.Second})

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
	// server-level outage as an inconclusive ErrRuntimeUnavailable rather than
	// a per-session death (issue #3475); both outcomes mean the handle is gone.
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

	r := New(Options{Timeout: 5 * time.Second})
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
	r := New(Options{Timeout: 5 * time.Second})
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
	deadline := time.Now().Add(5 * time.Second)
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
	deadline = time.Now().Add(5 * time.Second)
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

func TestSupervisorProcessHelper(t *testing.T) {
	if os.Getenv("AO_TMUX_SUPERVISOR_HELPER") != "1" {
		return
	}
	time.Sleep(2 * time.Second)
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

// TestRuntimeIntegrationDestroyDetachesClientUnderDetachOnDestroyOff pins the
// fix for a config-dependent cross-session leak.
//
// tmux's `detach-on-destroy off` — a common tmux.conf line, because it keeps you
// inside tmux when you kill a session — makes tmux move an attached client to
// another session instead of detaching it. AO's terminal attachment is such a
// client, so destroying an AO session silently reparented AO's PTY onto one of
// the user's own sessions: the stream never EOF'd (so the attachment never saw
// the session end), the other session's output streamed into AO's terminal
// view, and anything typed there executed in that session's pane.
//
// Create now sets detach-on-destroy back to `on` for AO's own sessions only.
// The test uses a private tmux server (TMUX_TMPDIR + `-f /dev/null`) with the
// global set to `off`, so it reproduces on a default machine and never touches
// the developer's own tmux.
func TestRuntimeIntegrationDestroyDetachesClientUnderDetachOnDestroyOff(t *testing.T) {
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux unavailable")
	}
	// tmux refuses to attach a client without a usable TERM.
	t.Setenv("TERM", "xterm-256color")

	// os.MkdirTemp rather than t.TempDir: the tmux socket is a unix path capped
	// near 108 bytes and t.TempDir embeds this test's long name.
	tmuxTmp, err := os.MkdirTemp("", "aotmux")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Setenv("TMUX_TMPDIR", tmuxTmp)
	t.Cleanup(func() {
		_ = exec.Command("tmux", "kill-server").Run()
		_ = os.RemoveAll(tmuxTmp)
	})

	// "bystander" stands in for a session of the user's own; it is also what
	// holds the server open long enough to set the global option. `-f /dev/null`
	// skips the developer's tmux.conf so the global below is the only one in play.
	if out, err := exec.Command("tmux", "-f", "/dev/null", "new-session", "-d", "-s", "ao-dod-bystander", "sh", "-c", "sleep 120").CombinedOutput(); err != nil {
		t.Skipf("cannot start private tmux server: %v: %s", err, out)
	}
	if out, err := exec.Command("tmux", "set-option", "-g", "detach-on-destroy", "off").CombinedOutput(); err != nil {
		t.Fatalf("set detach-on-destroy off: %v: %s", err, out)
	}

	ctx := context.Background()
	r := New(Options{Timeout: 5 * time.Second})
	h, err := r.Create(ctx, ports.RuntimeConfig{
		SessionID:     domain.SessionID("ao-dod-" + strings.ReplaceAll(t.Name(), "/", "_")),
		WorkspacePath: t.TempDir(),
		Argv:          []string{"sh", "-c", "echo agent-running"},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() { _ = r.Destroy(context.Background(), h) })

	stream, err := r.Attach(ctx, h, 50, 220)
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	t.Cleanup(func() { _ = stream.Close() })

	readErr := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, err := stream.Read(buf); err != nil {
				readErr <- err
				return
			}
		}
	}()

	// Wait for the client to actually be attached before destroying, otherwise
	// the test could pass simply by racing the attach.
	deadline := time.Now().Add(5 * time.Second)
	for {
		out, _ := exec.Command("tmux", "list-clients", "-F", "#{client_session}").Output()
		if strings.Contains(string(out), h.ID) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("attach client never appeared; clients = %q", out)
		}
		time.Sleep(50 * time.Millisecond)
	}

	if err := r.Destroy(ctx, h); err != nil {
		t.Fatalf("Destroy: %v", err)
	}

	// The attach client must end, not survive on another session.
	select {
	case <-readErr:
	case <-time.After(5 * time.Second):
		out, _ := exec.Command("tmux", "list-clients", "-F", "#{client_session}").Output()
		t.Fatalf("attach stream never ended after Destroy; tmux clients now on: %q", strings.TrimSpace(string(out)))
	}

	out, err := exec.Command("tmux", "list-clients", "-F", "#{client_session}").Output()
	if err != nil {
		t.Fatalf("list-clients: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "" {
		t.Fatalf("client survived on session %q, want no attached clients — tmux reparented AO's terminal onto another session", got)
	}
}

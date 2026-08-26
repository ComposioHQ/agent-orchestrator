// Package tmux implements ports.Runtime using tmux sessions on Darwin/Linux.
package tmux

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tmuxbin"
)

const (
	defaultTimeout        = 5 * time.Second
	defaultChunkBytes     = 16 * 1024
	qualifiedHandlePrefix = "ao-tmux-v1"
	legacyNamedSocket     = "ao"
	// defaultEnterDelay mirrors conpty's ptyInputEnterDelay: a pause after pasting
	// a non-empty message, before the trailing Enter, so a large multiline paste
	// does not absorb the Enter and leave the prompt unsubmitted (issue #2342).
	defaultEnterDelay = 300 * time.Millisecond
	// defaultReapGrace is how long Destroy waits between SIGTERM and SIGKILL when
	// reaping a pane's leftover background processes, giving them a chance to
	// exit cleanly (release ports) before being forced (issue #2523). It is a
	// ceiling, not a fixed wait: reapPollInterval decides how soon a pane that
	// is already empty lets Destroy return.
	defaultReapGrace = 5 * time.Second
	// reapPollInterval is how often the reap rechecks for survivors while the
	// grace runs. A plain shell exits within a tick or two, so Destroy returns
	// in roughly this long instead of always burning the full grace — which the
	// DELETE handler blocks on, and the user sees as a tab that will not close.
	reapPollInterval = 50 * time.Millisecond
)

var sessionIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

var getenv = os.Getenv

// Options configures a tmux Runtime. SocketPath is required for every newly
// created session. RunFilePath enables ownership-verified reconciliation of
// unqualified handles created before AO persisted the tmux namespace.
type Options struct {
	Binary       string        // default configured/bundled/system tmux resolution
	LegacyBinary string        // system tmux compatible with the historical default-socket server
	SocketPath   string        // required private socket path, passed to every new-session client with -S
	RunFilePath  string        // current absolute running.json path; empty disables legacy adoption
	Shell        string        // default $SHELL else /bin/sh
	Timeout      time.Duration // default 5s
	ChunkSize    int           // default 16*1024
	EnterDelay   time.Duration // pause after pasting a non-empty message before pressing Enter; default defaultEnterDelay. Conpty already does this (ptyInputEnterDelay); tmux lacked it, so a large multiline paste could absorb the trailing Enter and leave the prompt unsubmitted (issue #2342).
	ReapGrace    time.Duration // grace between SIGTERM and SIGKILL when reaping a pane's leftover background processes on Destroy; default defaultReapGrace.
}

type sessionRoute uint8

const (
	routePrivate sessionRoute = iota
	routeLegacyNamed
	routeLegacyDefault
)

func (r sessionRoute) handleName() string {
	switch r {
	case routePrivate:
		return "private"
	case routeLegacyNamed:
		return "named"
	case routeLegacyDefault:
		return "default"
	default:
		return "unknown"
	}
}

func routeFromHandleName(name string) (sessionRoute, bool) {
	switch name {
	case "private":
		return routePrivate, true
	case "named":
		return routeLegacyNamed, true
	case "default":
		return routeLegacyDefault, true
	default:
		return routePrivate, false
	}
}

// Runtime runs agent sessions inside tmux sessions, driving them via the tmux
// CLI. It implements ports.Runtime.
type Runtime struct {
	binary           string
	binaryResolveErr error
	legacyBinary     string
	socketPath       string
	runFilePath      string
	shell            string
	timeout          time.Duration
	chunkSize        int
	enterDelay       time.Duration
	reapGrace        time.Duration
	runner           runner
	reapSessions     func(ctx context.Context, pids []int, grace time.Duration)
	syncEnvironment  func(ctx context.Context, sessionID string, configured map[string]string) error
	routeMu          sync.RWMutex
	sessionRoutes    map[string]sessionRoute
	routeLaunchIDs   map[string]string
}

var _ ports.Runtime = (*Runtime)(nil)
var _ ports.Attacher = (*Runtime)(nil)
var _ ports.RuntimeIdentityInspector = (*Runtime)(nil)

type runner interface {
	Run(ctx context.Context, env []string, stdin []byte, name string, args ...string) ([]byte, error)
}

// killSessionsByPID force-terminates every process in each pid's tmux pane
// session. tmux runs each pane in its own session (pane pid == session id), so
// signaling the session reaps the pane's background children — e.g. a dev
// server a worker started with `&` — that `kill-session`'s SIGHUP leaves
// running. It SIGTERMs, waits grace for a clean exit, then
// SIGKILLs survivors. Best-effort: `pkill` is absent on Windows, where tmux is
// never the runtime, so the calls simply no-op there.
func killSessionsByPID(ctx context.Context, pids []int, grace time.Duration) {
	reapPaneSessions(ctx, pids, grace, signalSessions, sessionsHaveProcesses)
}

// reapPaneSessions is killSessionsByPID's logic with the pkill/pgrep calls
// injected, so the SIGTERM → wait → SIGKILL sequence is testable without real
// processes.
func reapPaneSessions(
	ctx context.Context,
	pids []int,
	grace time.Duration,
	signal func(ctx context.Context, pids []int, sig string) bool,
	hasProcesses func(ctx context.Context, pids []int) bool,
) {
	if len(pids) == 0 {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace+5*time.Second)
	defer cancel()

	// `-s` is a Linux procps extension; BSD/macOS pkill rejects it outright. When
	// the platform cannot signal by session id, no amount of waiting reaps
	// anything — the SIGTERM never landed and the SIGKILL would not either — so
	// return instead of blocking the caller for the whole grace. Destroy runs
	// inside the shell-terminal DELETE handler, and that dead wait was the
	// several-second delay users saw when closing a terminal on macOS.
	if !signal(cleanupCtx, pids, "-TERM") {
		return
	}
	if !hasProcesses(cleanupCtx, pids) {
		return
	}

	// Poll rather than sleep the whole grace. Callers block on this (Destroy runs
	// inside the shell-terminal DELETE handler), and the common case — an
	// interactive shell with nothing behind it — is empty almost immediately. A
	// process that really needs the time still gets the full grace before SIGKILL.
	deadline := time.NewTimer(grace)
	defer deadline.Stop()
	ticker := time.NewTicker(reapPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-cleanupCtx.Done():
			return
		case <-ticker.C:
			if !hasProcesses(cleanupCtx, pids) {
				return
			}
		case <-deadline.C:
			if !hasProcesses(cleanupCtx, pids) {
				return
			}
			signal(cleanupCtx, pids, "-KILL")
			return
		}
	}
}

// signalSessions sends a pkill signal flag (e.g. "-TERM") to every process in
// each pane session, matched by session id via `pkill -s`. It reports whether
// the platform supports signalling by session id at all: exit 2 is a usage
// error on both procps and BSD pkill, which is how macOS answers `-s`, and
// there the call reaches no process.
func signalSessions(ctx context.Context, pids []int, sig string) bool {
	supported := false
	for _, pid := range pids {
		err := exec.CommandContext(ctx, "pkill", sig, "-s", strconv.Itoa(pid)).Run()
		if !isUnsupportedMatcher(err) {
			supported = true
		}
	}
	return supported
}

// isUnsupportedMatcher reports whether a pgrep/pkill invocation failed because
// the platform rejects the matcher itself (exit 2, a usage error) rather than
// because nothing matched (exit 1) or the process is missing entirely.
func isUnsupportedMatcher(err error) bool {
	if err == nil {
		return false
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode() >= 2
	}
	// pkill/pgrep absent (Windows, minimal containers): equally unusable.
	return true
}

// sessionsHaveProcesses reports whether any process remains in the pane
// sessions. `pgrep` exit 1 means no matches; other failures are treated as
// survivors so Destroy stays conservative and still attempts SIGKILL.
func sessionsHaveProcesses(ctx context.Context, pids []int) bool {
	for _, pid := range pids {
		err := exec.CommandContext(ctx, "pgrep", "-s", strconv.Itoa(pid)).Run()
		if err == nil || ctx.Err() != nil {
			return true
		}
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			return true
		}
	}
	return false
}

type execRunner struct{}

func (execRunner) Run(ctx context.Context, env []string, stdin []byte, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	// A non-nil environment is a complete, already-sanitized control
	// environment. Do not append os.Environ here: doing so would silently
	// reintroduce a surrounding TMUX identity and AO's internal tmux selectors.
	// Nil retains os/exec's ordinary inherited-environment behavior for narrow
	// callers and tests that do not supply an environment.
	if env != nil {
		cmd.Env = append([]string(nil), env...)
	}
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	// Run from a stable directory, not whatever the daemon process's cwd happens
	// to be. The first tmux CLI call auto-starts tmux's persistent server, which
	// inherits ITS launching process's cwd and keeps it for the server's entire
	// lifetime, regardless of what any later `new-session -c <dir>` asks for
	// (issue #2775). A packaged desktop build can start the daemon with its cwd
	// inside a Squirrel/ShipIt staging directory that the very next auto-update
	// deletes, permanently pinning the tmux server to a path that no longer
	// exists. os.TempDir() outlives app bundle swaps and update staging dirs, so
	// pinning here keeps the server cwd valid across the app's lifetime.
	cmd.Dir = stableRunDir()
	return cmd.CombinedOutput()
}

// stableRunDir returns the directory execRunner.Run pins the tmux CLI to.
//
// os.TempDir() is the preferred answer (see execRunner.Run), but it returns
// $TMPDIR verbatim without checking that it exists. A stale or bogus TMPDIR
// would then make exec fail with "chdir <dir>: no such file or directory" on
// EVERY tmux command, taking the whole runtime down for exactly the reason
// #2775 did: a cwd that no longer exists. So stat the candidates and degrade
// rather than hard-fail. The last resort is the empty string, which leaves
// cmd.Dir unset so the command inherits the daemon's own cwd: that is the
// pre-fix behavior and merely risks the poisoned-server race the pin avoids,
// which the retry in verifyPaneWorkingDirectory already tolerates.
func stableRunDir() string {
	candidates := []string{os.TempDir()}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, home)
	}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}
	}
	return ""
}

// New builds a tmux Runtime, filling unset Options with defaults: binary from
// AO's configured/bundled/system resolver; shell from $SHELL (else /bin/sh); and the
// default timeout and output chunk size.
func New(opts Options) *Runtime {
	binary := opts.Binary
	var binaryResolveErr error
	if binary == "" {
		resolution, err := tmuxbin.Resolve()
		if err == nil {
			binary = resolution.Path
		} else {
			binaryResolveErr = fmt.Errorf("tmux runtime: resolve tmux binary: %w", err)
			// Retain the configured value for diagnostics, but managedArgs returns
			// binaryResolveErr before any execution. In particular, a damaged
			// packaged layout can never fall through to a machine tmux on PATH.
			binary = strings.TrimSpace(getenv("AO_TMUX_BINARY"))
		}
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = defaultTimeout
	}
	shellPath := opts.Shell
	if shellPath == "" {
		shellPath = getenv("SHELL")
	}
	if shellPath == "" {
		shellPath = "/bin/sh"
	}
	chunkSize := opts.ChunkSize
	if chunkSize <= 0 {
		chunkSize = defaultChunkBytes
	}
	enterDelay := opts.EnterDelay
	if enterDelay <= 0 {
		enterDelay = defaultEnterDelay
	}
	reapGrace := opts.ReapGrace
	if reapGrace <= 0 {
		reapGrace = defaultReapGrace
	}
	legacyBinary := strings.TrimSpace(opts.LegacyBinary)
	runFilePath := strings.TrimSpace(opts.RunFilePath)
	if runFilePath != "" && legacyBinary == "" {
		if systemTmux, err := exec.LookPath("tmux"); err == nil {
			legacyBinary = systemTmux
		}
	}
	runtime := &Runtime{
		binary:           binary,
		binaryResolveErr: binaryResolveErr,
		legacyBinary:     legacyBinary,
		socketPath:       opts.SocketPath,
		runFilePath:      runFilePath,
		shell:            shellPath,
		timeout:          timeout,
		chunkSize:        chunkSize,
		enterDelay:       enterDelay,
		reapGrace:        reapGrace,
		runner:           execRunner{},
		reapSessions:     killSessionsByPID,
		sessionRoutes:    make(map[string]sessionRoute),
		routeLaunchIDs:   make(map[string]string),
	}
	runtime.syncEnvironment = runtime.syncCurrentEnvironment
	return runtime
}

// Create starts a new tmux session in the workspace, running the agent's
// launch command with a keep-alive shell, and returns a handle to it.
func (r *Runtime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id, err := tmuxSessionName(cfg.SessionID)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: workspace path is required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: launch command is required")
	}
	if err := validateEnvKeys(cfg.Env); err != nil {
		return ports.RuntimeHandle{}, err
	}

	// Start a harmless bootstrap pane first, then populate the session's
	// environment over tmux's stdin channel before launching the real command.
	// This keeps cfg.Env values out of both the tmux client's argv and the
	// long-lived pane shell's argv.
	args := newSessionArgs(id, cfg.WorkspacePath, r.shell, "exec cat >/dev/null")
	if _, err := r.run(ctx, args...); err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: create session %s: %w", id, err)
	}
	r.rememberSessionRoute(id, routePrivate, "")
	handle := qualifiedRuntimeHandle(routePrivate, id)
	if err := r.syncEnvironment(ctx, id, cfg.Env); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: refresh environment for session %s: %w", id, err)
	}
	launchCmd := buildLaunchCommand(cfg)
	if _, err := r.runForSession(ctx, id, respawnPaneArgs(id, cfg.WorkspacePath, r.shell, launchCmd)...); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: launch session %s: %w", id, err)
	}
	if err := r.verifyPaneWorkingDirectory(ctx, id, cfg.WorkspacePath); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, err
	}

	// Hide the status bar in the embedded terminal: it clutters the view and
	// was not designed for the in-browser display context.
	if _, err := r.run(ctx, setStatusOffArgs(id)...); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: set status %s: %w", id, err)
	}

	// Enable mouse mode so the embedded terminal's SGR wheel reports scroll the
	// pane (see setMouseOnArgs). Without it, wheel scrolling silently no-ops.
	if _, err := r.run(ctx, setMouseOnArgs(id)...); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: set mouse %s: %w", id, err)
	}

	// Size the shared window to the largest attached client, not the most recent
	// one, so a small secondary viewer (e.g. the phone) can't strip down a larger
	// client's view (see setWindowSizeLargestArgs).
	if _, err := r.run(ctx, setWindowSizeLargestArgs(id)...); err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: set window-size %s: %w", id, err)
	}

	alive, err := r.IsAlive(ctx, handle)
	if err != nil {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: verify session %s: %w", id, err)
	}
	if !alive {
		_ = r.Destroy(context.Background(), handle)
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: session %s exited before ready", id)
	}
	return handle, nil
}

// Restart replaces the command in an existing pane while preserving the tmux
// session. This is used to resume an exited agent without discarding terminal
// history or forcing attached clients onto a new handle.
func (r *Runtime) Restart(ctx context.Context, handle ports.RuntimeHandle, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	expectedID, err := tmuxSessionName(cfg.SessionID)
	if err != nil {
		return ports.RuntimeHandle{}, err
	}
	if expectedID != id {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: restart handle %s does not match session %s", id, cfg.SessionID)
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: workspace path is required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, errors.New("tmux runtime: launch command is required")
	}
	if err := validateEnvKeys(cfg.Env); err != nil {
		return ports.RuntimeHandle{}, err
	}
	entries, panePID, err := r.supervisedProcessTree(ctx, handle)
	if err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: verify restart ownership for session %s: %w", id, err)
	}
	if containsSupervisorForSession(entries, panePID, string(cfg.SessionID)) {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: refuse to restart session %s: %w", id, ports.ErrRuntimeBusy)
	}

	if err := r.syncEnvironment(ctx, id, cfg.Env); err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: refresh environment for session %s: %w", id, err)
	}
	launchCmd := buildLaunchCommand(cfg)
	if _, err := r.runForSession(ctx, id, respawnPaneArgs(id, cfg.WorkspacePath, r.shell, launchCmd)...); err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: restart session %s: %w", id, err)
	}
	alive, err := r.IsAlive(ctx, handle)
	if err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: verify restarted session %s: %w", id, err)
	}
	if !alive {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: session %s exited during restart", id)
	}
	route, err := r.routeForSession(ctx, id)
	if err != nil {
		return ports.RuntimeHandle{}, fmt.Errorf("tmux runtime: resolve restarted session %s: %w", id, err)
	}
	return qualifiedRuntimeHandle(route, id), nil
}

// paneCwdVerifyAttempts and paneCwdVerifyRetryDelay bound how long Create
// waits for the pane's working directory to settle before giving up.
// buildLaunchCommand's `cd '<workspace>' || exit;` guard corrects a pane that
// started in the tmux server's own (possibly poisoned) cwd, but only once the
// pane's shell actually runs that cd. Measured live on 2026-07-25:
// #{pane_current_path} sampled immediately after `new-session` was stale, and
// the same probe sampled 50ms later was already correct. A single-shot check
// therefore lost that race every time and turned a spawn that was actually
// going to succeed into a hard failure (issue #2775): retrying gives the cd
// guard the moment it needs to run.
const (
	paneCwdVerifyAttempts   = 5
	paneCwdVerifyRetryDelay = 50 * time.Millisecond
)

func (r *Runtime) verifyPaneWorkingDirectory(ctx context.Context, id, want string) error {
	var lastErr error
	for attempt := 0; attempt < paneCwdVerifyAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(paneCwdVerifyRetryDelay):
			}
		}
		out, err := r.run(ctx, paneCurrentPathArgs(id)...)
		if err != nil {
			// A later transient probe failure (e.g. a one-off tmux CLI hiccup)
			// must not overwrite an already-observed cwd mismatch: the mismatch
			// is the classifiable, actionable error toAPIError maps via
			// ports.ErrRuntimeWorkspaceCwdMismatch (Fix 4), and losing it here
			// would silently regress that mapping back to a bare, unclassifiable
			// 500 whenever the very last attempt happened to hit a probe error.
			if !errors.Is(lastErr, ports.ErrRuntimeWorkspaceCwdMismatch) {
				lastErr = fmt.Errorf("tmux runtime: verify working directory %s: %w", id, err)
			}
			continue
		}
		got := strings.TrimSpace(string(out))
		if sameDirectory(got, want) {
			return nil
		}
		lastErr = fmt.Errorf(
			"%w: session %s started in %q, want %q (the worktree may be missing, or the tmux server may be pinned to a stale directory)",
			ports.ErrRuntimeWorkspaceCwdMismatch, id, got, want,
		)
	}
	return lastErr
}

// Destroy kills the handle's tmux session and reaps the pane processes it
// leaves behind. `tmux kill-session` only SIGHUPs each pane's foreground
// process, so a worker's backgrounded children (e.g. a dev server started with
// `&`, later reparented to init) survive it and hold their ports indefinitely
// (issue #2523). To catch those, Destroy records each pane's session id before
// teardown and, after kill-session, signals the whole session (see
// killSessionsByPID). An already-gone session is treated as success (idempotent).
func (r *Runtime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return err
	}
	// Capture pane session ids while the session still exists; a missing
	// session lists no panes and reaps nothing. Best-effort: failures here must
	// not block the kill-session below.
	sessionIDs := r.paneSessionIDs(ctx, id)

	out, err := r.runForSession(ctx, id, killSessionArgs(id)...)
	// Reap regardless of the kill-session result: orphaned children outlive the
	// session, so they must be cleaned up even when the session was already
	// gone (a benign double-kill).
	r.reapSessions(ctx, sessionIDs, r.reapGrace)

	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && killSessionMissingOutput(string(out)) {
			r.forgetSessionRoute(id)
			return nil
		}
		return fmt.Errorf("tmux runtime: destroy session %s: %w", id, err)
	}
	r.forgetSessionRoute(id)
	return nil
}

// paneSessionIDs lists the pid of every pane in the session. tmux launches each
// pane in its own session (setsid), so a pane's pid is also its session id —
// the handle killSessionsByPID uses to reap the pane's descendants. Best-effort:
// any error (including a missing session) or unparseable line yields no ids,
// and pids <= 1 are skipped so we never signal init or the "current session".
func (r *Runtime) paneSessionIDs(ctx context.Context, id string) []int {
	out, err := r.runForSession(ctx, id, listPanePIDsArgs(id)...)
	if err != nil {
		return nil
	}
	var ids []int
	for _, line := range strings.Split(string(out), "\n") {
		pid, convErr := strconv.Atoi(strings.TrimSpace(line))
		if convErr != nil || pid <= 1 {
			continue
		}
		ids = append(ids, pid)
	}
	return ids
}

// IsAlive reports whether the handle's session still exists via `tmux
// has-session`. Exit 0 means alive. A non-zero exit with output naming this
// session as missing is a definitive false, nil. A conclusively absent server
// wraps ports.ErrRuntimeUnavailable so recovery may recreate it. A transient
// connection or protocol/client failure wraps ErrRuntimeProbeInconclusive so
// no caller can treat a possibly-live session as absent. Any other non-zero
// exit is a plain probe error, which is likewise never per-session death.
func (r *Runtime) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return false, err
	}
	out, err := r.runForSession(ctx, id, hasSessionArgs(id)...)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			if sessionMissingOutput(string(out)) {
				return false, nil
			}
			if serverNotRunningOutput(string(out)) {
				return false, fmt.Errorf("tmux runtime: probe session %s: %w: %s",
					id, ports.ErrRuntimeUnavailable, strings.TrimSpace(string(out)))
			}
			if transientServerFailureOutput(string(out)) {
				return false, fmt.Errorf("tmux runtime: probe session %s: %w: %s",
					id, ports.ErrRuntimeProbeInconclusive, strings.TrimSpace(string(out)))
			}
		}
		return false, fmt.Errorf("tmux runtime: probe session %s: %w", id, err)
	}
	return true, nil
}

// IsSupervisedProcessAlive reports whether the managed workload for ref is
// still a descendant of this tmux pane. The initial launch is identified by
// its exact AO supervisor. After that supervisor exits and leaves the
// interactive shell behind, a child launched from that shell is treated as a
// manually resumed workload. Command failures remain inconclusive.
func (r *Runtime) IsSupervisedProcessAlive(ctx context.Context, handle ports.RuntimeHandle, ref ports.SupervisedProcessRef) (bool, error) {
	entries, panePID, err := r.supervisedProcessTree(ctx, handle)
	if err != nil {
		return false, err
	}
	alive := containsManagedWorkload(entries, panePID, string(ref.SessionID), ref.LaunchID)
	if !alive && containsSupervisorForSession(entries, panePID, string(ref.SessionID)) {
		return false, fmt.Errorf("tmux runtime: supervised generation differs for session %s: %w", ref.SessionID, ports.ErrRuntimeProbeInconclusive)
	}
	return alive, nil
}

// IsExactSupervisedProcessAlive reports only the AO supervisor matching ref
// while that supervisor still owns a live managed child. It deliberately
// excludes both the manual-child fallback used by the ordinary reaper probe
// and a supervisor that is merely waiting to durably report its child's exit:
// neither is proof that an agent can safely receive a continuation.
func (r *Runtime) IsExactSupervisedProcessAlive(ctx context.Context, handle ports.RuntimeHandle, ref ports.SupervisedProcessRef) (bool, error) {
	if ref.SessionID == "" || strings.TrimSpace(ref.LaunchID) == "" {
		return false, errors.New("tmux runtime: exact supervisor session and launch are required")
	}
	entries, panePID, err := r.supervisedProcessTree(ctx, handle)
	if err != nil {
		return false, err
	}
	return containsExactSupervisedWorkload(entries, panePID, string(ref.SessionID), ref.LaunchID), nil
}

func (r *Runtime) supervisedProcessTree(ctx context.Context, handle ports.RuntimeHandle) ([]processEntry, int, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return nil, 0, err
	}
	paneOut, err := r.runForSession(ctx, id, panePIDArgs(id)...)
	if err != nil {
		return nil, 0, fmt.Errorf("tmux runtime: inspect pane pid %s: %w", id, err)
	}
	panePID, err := strconv.Atoi(strings.TrimSpace(string(paneOut)))
	if err != nil || panePID <= 0 {
		return nil, 0, fmt.Errorf("tmux runtime: invalid pane pid %q", strings.TrimSpace(string(paneOut)))
	}
	processOut, err := r.runCommand(ctx, "ps", "-ww", "-axo", "pid=,ppid=,args=")
	if err != nil {
		return nil, 0, fmt.Errorf("tmux runtime: inspect process tree %s: %w", id, err)
	}
	entries, err := parseProcessTable(string(processOut))
	if err != nil {
		return nil, 0, fmt.Errorf("tmux runtime: parse process tree %s: %w", id, err)
	}
	return entries, panePID, nil
}

// SendMessage sends literal text to the session (chunked via send-keys -l) then
// presses Enter to submit. An empty message presses Enter alone (the nudge
// contract on ports.AgentMessenger).
//
// ponytail: send-keys -l chunked is simpler than load-buffer/paste-buffer; the
// ceiling is very large messages may be slower, but chunk size defaults to 16 KB
// which is ample for agent prompts.
func (r *Runtime) SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return err
	}
	enterCtx := ctx
	if message != "" {
		messageChunks := chunks(message, r.chunkSize)
		sendCtx := ctx
		var finishCancel context.CancelFunc
		for i, chunk := range messageChunks {
			if _, err := r.runForSession(sendCtx, id, sendKeysLiteralArgs(id, chunk)...); err != nil {
				if finishCancel != nil {
					finishCancel()
				}
				return fmt.Errorf("tmux runtime: send message %s: %w", id, err)
			}
			if i == 0 {
				completionBudget := sendCompletionBudget(len(messageChunks), r.timeout, r.enterDelay)
				enterCtx, finishCancel = context.WithTimeout(context.WithoutCancel(ctx), completionBudget)
				sendCtx = enterCtx
			}
		}
		if finishCancel != nil {
			defer finishCancel()
		}
		// Give the target TUI a moment to accept the pasted text before the
		// trailing Enter, mirroring conpty's ptyInputEnterDelay. Without it a
		// large multiline paste can absorb the Enter and leave the prompt
		// unsubmitted (issue #2342). Empty-message nudges skip this — there is
		// no paste ahead of a catch-up Enter.
		//
		// From here on the chunks are already in the pane, so the pause and
		// the Enter are detached from the caller's cancellation (bounded by
		// their own timeout instead): abandoning mid-pause would strand an
		// unsubmitted draft that a retried send would then double-paste.
		// Errors reported by tmux after it accepts a chunk still return to the
		// caller; they are not retried because AO cannot safely distinguish
		// whether tmux applied the failed command.
		if r.enterDelay > 0 {
			select {
			case <-enterCtx.Done():
				return enterCtx.Err()
			case <-time.After(r.enterDelay):
			}
		}
	}
	if _, err := r.runForSession(enterCtx, id, sendEnterArgs(id)...); err != nil {
		return fmt.Errorf("tmux runtime: send enter %s: %w", id, err)
	}
	return nil
}

func sendCompletionBudget(chunkCount int, commandTimeout, enterDelay time.Duration) time.Duration {
	return time.Duration(chunkCount)*commandTimeout + enterDelay
}

// Interrupt sends Ctrl-C to the foreground process without destroying the tmux
// session, keeping the terminal available for inspection and reuse.
func (r *Runtime) Interrupt(ctx context.Context, handle ports.RuntimeHandle) error {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return err
	}
	if _, err := r.runForSession(ctx, id, sendInterruptArgs(id)...); err != nil {
		return fmt.Errorf("tmux runtime: interrupt session %s: %w", id, err)
	}
	return nil
}

// SendInput sends raw terminal input without appending Enter. It is intended
// for TUI keybindings such as Escape rather than prompt text.
func (r *Runtime) SendInput(ctx context.Context, handle ports.RuntimeHandle, input string) error {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return err
	}
	args := sendKeysLiteralArgs(id, input)
	if _, err := r.runForSession(ctx, id, args...); err != nil {
		return fmt.Errorf("tmux runtime: send input %s: %w", id, err)
	}
	return nil
}

// GetOutput returns the last `lines` lines of the session pane's captured
// output.
func (r *Runtime) GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return "", err
	}
	if lines <= 0 {
		return "", errors.New("tmux runtime: lines must be positive")
	}
	out, err := r.runForSession(ctx, id, capturePaneArgs(id, lines)...)
	if err != nil {
		return "", fmt.Errorf("tmux runtime: capture output %s: %w", id, err)
	}
	return tailLines(trimTrailingBlankLines(string(out)), lines), nil
}

// GetStyledOutput is GetOutput with tmux's -e flag so SGR styling is retained.
func (r *Runtime) GetStyledOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return "", err
	}
	if lines <= 0 {
		return "", errors.New("tmux runtime: lines must be positive")
	}
	out, err := r.runForSession(ctx, id, capturePaneStyledArgs(id, lines)...)
	if err != nil {
		return "", fmt.Errorf("tmux runtime: capture styled output %s: %w", id, err)
	}
	return tailLines(trimTrailingBlankLines(string(out)), lines), nil
}

// Attach opens a fresh attach Stream by spawning `tmux attach-session` on a
// local PTY, sized rows x cols from birth when known. ctx cancellation closes
// the PTY.
func (r *Runtime) Attach(ctx context.Context, handle ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return nil, err
	}
	route, err := r.routeForSession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("tmux runtime: attach session %s: %w", id, err)
	}
	argv, err := r.attachCommandForRoute(id, route)
	if err != nil {
		return nil, err
	}
	return ptyexec.Spawn(ctx, argv, controlEnv(os.Environ()), rows, cols)
}

// attachCommand returns the argv to attach a terminal to the session.
// tmux needs no per-session env block.
//
// -u forces tmux's client-side CLIENT_UTF8 flag on. Without it, tmux infers
// UTF-8 capability from LC_ALL/LC_CTYPE/LANG in the attaching process's env
// (see tmux's main()); AO's daemon is typically started without an
// interactive shell's locale, so that inference silently fails. A non-UTF8
// client makes tmux's tty_check_codeset (tty.c) replace any character it
// can't map through the legacy ACS table with underscores matching the
// glyph's display width. Box-drawing glyphs are in that ACS table so they
// still looked fine; agent CLI status icons outside it (e.g. Claude Code's
// spinner "✻" U+273B, its "⎿" U+23BF continuation marker) were silently
// rewritten to "_", which is the underscore corruption reported in #2484.
// Confirmed byte-for-byte: attaching with a stripped, locale-less env
// reproduces "_ _ _" for those glyphs; adding -u fixes it, with no observable
// difference for the still-correct box-drawing case. AO already treats the
// PTY byte stream as UTF-8 end to end, so forcing the flag is always
// correct here regardless of the daemon's own environment.
func (r *Runtime) attachCommand(handle ports.RuntimeHandle) ([]string, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return nil, err
	}
	// The embedded xterm renderer supports 24-bit SGR colors. Tell this tmux
	// client explicitly so tmux forwards RGB instead of quantizing it to the
	// xterm-256color palette. -T is available in AO's minimum tmux version (3.2).
	return r.attachCommandForRoute(id, routePrivate)
}

func (r *Runtime) attachCommandForRoute(id string, route sessionRoute) ([]string, error) {
	args := []string{"-u", "-T", "RGB", "attach-session", "-t", id}
	binary, managed, err := r.commandForRoute(route, args...)
	if err != nil {
		return nil, err
	}
	return append([]string{binary}, managed...), nil
}

// controlEnv returns the complete environment for tmux control and attach
// clients. Workload-relevant values (PATH, HOME, credentials, locale, SSH agent
// sockets, TERMINFO, TMUX_TMPDIR, and so on) are preserved because the tmux
// server is also the parent of AO's pane workloads. The inherited identity of
// a surrounding tmux client and AO's internal binary/socket selectors are
// removed. TERM and COLORTERM describe AO's embedded xterm surface and are
// forced exactly once.
func controlEnv(base []string) []string {
	env := make([]string, 0, len(base)+2)
	for _, kv := range base {
		key, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		switch {
		case isolatedTmuxEnvironmentKey(key), key == "TERM", key == "COLORTERM":
			continue
		default:
			env = append(env, kv)
		}
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
}

// managedArgs pins every tmux client to AO's explicit socket and an empty
// private config. A missing socket path fails closed: omitting -S would connect
// to the user's default tmux server.
func (r *Runtime) managedArgs(args ...string) ([]string, error) {
	if strings.TrimSpace(r.socketPath) == "" {
		return nil, errors.New("tmux runtime: private socket path is required")
	}
	if !filepath.IsAbs(r.socketPath) {
		return nil, errors.New("tmux runtime: private socket path must be absolute")
	}
	if r.binaryResolveErr != nil {
		return nil, r.binaryResolveErr
	}
	address, err := privateSocketAddress(r.socketPath)
	if err != nil {
		return nil, err
	}
	managed := make([]string, 0, 4+len(args))
	managed = append(managed, "-S", address, "-f", os.DevNull)
	return append(managed, args...), nil
}

func (r *Runtime) legacyArgs(args ...string) ([]string, error) {
	if strings.TrimSpace(r.legacyBinary) == "" {
		return nil, fmt.Errorf("%w: system tmux is unavailable for legacy default-socket inspection", ports.ErrRuntimeProbeInconclusive)
	}
	managed := make([]string, 0, 4+len(args))
	managed = append(managed, "-L", "default", "-f", os.DevNull)
	return append(managed, args...), nil
}

func (r *Runtime) namedArgs(args ...string) ([]string, error) {
	if r.binaryResolveErr != nil {
		return nil, r.binaryResolveErr
	}
	managed := make([]string, 0, 4+len(args))
	managed = append(managed, "-L", legacyNamedSocket, "-f", os.DevNull)
	return append(managed, args...), nil
}

func (r *Runtime) commandForRoute(route sessionRoute, args ...string) (string, []string, error) {
	switch route {
	case routePrivate:
		managed, err := r.managedArgs(args...)
		return r.binary, managed, err
	case routeLegacyNamed:
		managed, err := r.namedArgs(args...)
		return r.binary, managed, err
	case routeLegacyDefault:
		managed, err := r.legacyArgs(args...)
		return r.legacyBinary, managed, err
	default:
		return "", nil, fmt.Errorf("tmux runtime: unknown socket route %d", route)
	}
}

// routeForSession resolves an old unqualified handle across every tmux
// namespace shipped by AO. Exactly one ownership-verified pane is adoptable;
// multiple owned matches are a recovery-required conflict and foreign matches
// are never treated as proof that the AO runtime died.
func (r *Runtime) routeForSession(ctx context.Context, id string) (sessionRoute, error) {
	r.routeMu.RLock()
	route, ok := r.sessionRoutes[id]
	r.routeMu.RUnlock()
	if ok {
		return route, nil
	}
	if r.runFilePath == "" {
		return routePrivate, nil
	}

	first, foreign, err := r.scanOwnedRoutes(ctx, id)
	if err != nil {
		return routePrivate, err
	}
	if len(first) == 0 {
		if foreign {
			return routePrivate, fmt.Errorf("%w: same-named tmux session %s lacks AO ownership provenance", ports.ErrRuntimeProbeInconclusive, id)
		}
		return routePrivate, nil
	}
	if len(first) > 1 {
		return routePrivate, ambiguousRoutesError(id, first)
	}
	// Re-scan before caching so a controller which appears in another namespace
	// during provenance inspection cannot be silently ignored.
	second, _, err := r.scanOwnedRoutes(ctx, id)
	if err != nil {
		return routePrivate, err
	}
	if len(second) != 1 || second[0] != first[0] {
		if len(second) > 1 {
			return routePrivate, ambiguousRoutesError(id, second)
		}
		return routePrivate, fmt.Errorf("%w: tmux ownership for session %s changed during reconciliation", ports.ErrRuntimeProbeInconclusive, id)
	}
	r.rememberSessionRoute(id, first[0].route, first[0].launchID)
	return first[0].route, nil
}

type ownedRoute struct {
	route    sessionRoute
	launchID string
}

func (r *Runtime) scanOwnedRoutes(ctx context.Context, id string) ([]ownedRoute, bool, error) {
	routes := []sessionRoute{routePrivate, routeLegacyNamed, routeLegacyDefault}
	owned := make([]ownedRoute, 0, 1)
	foreign := false
	for _, route := range routes {
		out, err := r.runOnRoute(ctx, route, nil, hasSessionArgs(id)...)
		if err != nil {
			if ctx.Err() != nil {
				return nil, false, ctx.Err()
			}
			if routeDefinitelyAbsent(string(out)) {
				continue
			}
			return nil, false, fmt.Errorf("%w: inspect %s tmux session %s: %w", ports.ErrRuntimeProbeInconclusive, route.handleName(), id, err)
		}
		launchID, isOwned, err := r.inspectPaneIdentity(ctx, route, id)
		if err != nil {
			return nil, false, err
		}
		if !isOwned {
			foreign = true
			continue
		}
		owned = append(owned, ownedRoute{route: route, launchID: launchID})
	}
	return owned, foreign, nil
}

func ambiguousRoutesError(id string, candidates []ownedRoute) error {
	names := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		names = append(names, candidate.route.handleName())
	}
	return fmt.Errorf("tmux runtime: session %s has owned controllers in namespaces %s: %w", id, strings.Join(names, ","), ports.ErrRuntimeAmbiguous)
}

func routeDefinitelyAbsent(out string) bool {
	if sessionMissingOutput(out) || serverNotRunningOutput(out) {
		return true
	}
	return privateSocketMissingOutput(out)
}

// A never-started explicit -S server is reported by tmux as an error
// connecting to a nonexistent socket, not as "no server running". This exact
// ENOENT form is conclusive for the private socket at the instant of the probe;
// other connection failures remain inconclusive. routeForSession re-probes
// after legacy provenance inspection to close a concurrent-create race.
func privateSocketMissingOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "error connecting") && strings.Contains(s, "no such file or directory")
}

func (r *Runtime) inspectPaneIdentity(ctx context.Context, route sessionRoute, id string) (string, bool, error) {
	out, err := r.runOnRoute(ctx, route, nil, paneStartCommandsArgs(id)...)
	if err != nil {
		return "", false, fmt.Errorf("%w: inspect %s pane provenance for %s: %w", ports.ErrRuntimeProbeInconclusive, route.handleName(), id, err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 1 {
		return "", false, nil
	}
	launchID, owned := legacyPaneIdentity(lines[0], id, r.runFilePath)
	return launchID, owned, nil
}

func legacyPaneIdentity(command, id, runFilePath string) (string, bool) {
	required := []string{
		"export AO_RUN_FILE=" + shellQuote(runFilePath) + ";",
		"export AO_SESSION_ID=" + shellQuote(id) + ";",
		"export AO_SUPERVISED_PROCESS='1';",
	}
	for _, fragment := range required {
		if !strings.Contains(command, fragment) {
			return "", false
		}
	}
	pattern := regexp.MustCompile(
		`'agent-process'\s+'supervise'\s+'--session'\s+'` + regexp.QuoteMeta(id) + `'\s+'--launch'\s+'([^']+)'`,
	)
	match := pattern.FindStringSubmatch(command)
	if len(match) != 2 || strings.TrimSpace(match[1]) == "" {
		return "", false
	}
	return match[1], true
}

func (r *Runtime) rememberSessionRoute(id string, route sessionRoute, launchID string) {
	r.routeMu.Lock()
	r.sessionRoutes[id] = route
	if launchID != "" {
		r.routeLaunchIDs[id] = launchID
	} else {
		delete(r.routeLaunchIDs, id)
	}
	r.routeMu.Unlock()
}

func (r *Runtime) forgetSessionRoute(id string) {
	r.routeMu.Lock()
	delete(r.sessionRoutes, id)
	delete(r.routeLaunchIDs, id)
	r.routeMu.Unlock()
}

// InspectRuntimeIdentity returns the qualified namespace handle, launch
// generation, and exact workload state recovered from an ownership-verified
// pane. Boot reconciliation persists these facts for every old bare handle.
func (r *Runtime) InspectRuntimeIdentity(ctx context.Context, handle ports.RuntimeHandle, sessionID domain.SessionID) (ports.RuntimeIdentity, error) {
	id, err := r.resolveHandle(handle)
	if err != nil {
		return ports.RuntimeIdentity{}, err
	}
	if id != string(sessionID) {
		return ports.RuntimeIdentity{}, fmt.Errorf("tmux runtime: identity handle %s does not match session %s", id, sessionID)
	}
	route, err := r.routeForSession(ctx, id)
	if err != nil {
		return ports.RuntimeIdentity{}, err
	}
	r.routeMu.RLock()
	launchID := r.routeLaunchIDs[id]
	r.routeMu.RUnlock()
	if launchID == "" {
		var owned bool
		launchID, owned, err = r.inspectPaneIdentity(ctx, route, id)
		if err != nil {
			return ports.RuntimeIdentity{}, err
		}
		if !owned {
			return ports.RuntimeIdentity{}, fmt.Errorf("%w: selected %s session %s has no AO provenance", ports.ErrRuntimeProbeInconclusive, route.handleName(), id)
		}
	}
	qualified := qualifiedRuntimeHandle(route, id).ID
	workloadAlive, err := r.IsExactSupervisedProcessAlive(ctx, qualifiedRuntimeHandle(route, id), ports.SupervisedProcessRef{
		SessionID: sessionID,
		LaunchID:  launchID,
	})
	if err != nil {
		return ports.RuntimeIdentity{}, fmt.Errorf("%w: inspect selected %s workload for %s: %w", ports.ErrRuntimeProbeInconclusive, route.handleName(), id, err)
	}
	return ports.RuntimeIdentity{HandleID: qualified, LaunchID: launchID, Legacy: handle.ID != qualified, WorkloadAlive: workloadAlive}, nil
}

// run wraps runner.Run with a per-call timeout context.
func (r *Runtime) run(ctx context.Context, args ...string) ([]byte, error) {
	return r.runWithInput(ctx, nil, args...)
}

// runWithInput is run with bytes connected to the tmux client's stdin. It is
// used for source-file so environment values never appear in process argv.
func (r *Runtime) runWithInput(ctx context.Context, input []byte, args ...string) ([]byte, error) {
	managed, err := r.managedArgs(args...)
	if err != nil {
		return nil, err
	}
	return r.runCommandWithInput(ctx, input, r.binary, managed...)
}

func (r *Runtime) runForSession(ctx context.Context, id string, args ...string) ([]byte, error) {
	return r.runWithInputForSession(ctx, id, nil, args...)
}

func (r *Runtime) runWithInputForSession(ctx context.Context, id string, input []byte, args ...string) ([]byte, error) {
	route, err := r.routeForSession(ctx, id)
	if err != nil {
		return nil, err
	}
	return r.runOnRoute(ctx, route, input, args...)
}

func (r *Runtime) runOnLegacy(ctx context.Context, input []byte, args ...string) ([]byte, error) {
	return r.runOnRoute(ctx, routeLegacyDefault, input, args...)
}

func (r *Runtime) runOnRoute(ctx context.Context, route sessionRoute, input []byte, args ...string) ([]byte, error) {
	binary, managed, err := r.commandForRoute(route, args...)
	if err != nil {
		return nil, err
	}
	return r.runCommandWithInput(ctx, input, binary, managed...)
}

func (r *Runtime) runCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return r.runCommandWithInput(ctx, nil, name, args...)
}

func (r *Runtime) runCommandWithInput(ctx context.Context, input []byte, name string, args ...string) ([]byte, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	out, err := r.runner.Run(cmdCtx, controlEnv(os.Environ()), input, name, args...)
	if cmdCtx.Err() != nil {
		return out, cmdCtx.Err()
	}
	if err != nil {
		return out, commandError{err: err, output: strings.TrimSpace(string(out))}
	}
	return out, nil
}

type processEntry struct {
	pid     int
	ppid    int
	command string
}

func parseProcessTable(out string) ([]processEntry, error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	entries := make([]processEntry, 0, len(lines))
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			return nil, fmt.Errorf("invalid pid in %q", line)
		}
		ppid, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("invalid parent pid in %q", line)
		}
		entries = append(entries, processEntry{pid: pid, ppid: ppid, command: strings.Join(fields[2:], " ")})
	}
	return entries, nil
}

func descendantPIDs(entries []processEntry, rootPID int) map[int]bool {
	descendants := map[int]bool{rootPID: true}
	for changed := true; changed; {
		changed = false
		for _, entry := range entries {
			if descendants[entry.pid] || !descendants[entry.ppid] {
				continue
			}
			descendants[entry.pid] = true
			changed = true
		}
	}
	return descendants
}

func containsManagedWorkload(entries []processEntry, rootPID int, sessionID, launchID string) bool {
	descendants := descendantPIDs(entries, rootPID)
	hasChild := false
	hasSupervisor := false
	for _, entry := range entries {
		if entry.pid == rootPID || !descendants[entry.pid] {
			continue
		}
		hasChild = true
		if !isAnySupervisorCommand(entry.command) {
			continue
		}
		hasSupervisor = true
		if isSupervisorCommand(entry.command, sessionID, launchID) {
			return true
		}
	}

	// A supervisor in the pane tree must match the current generation. Once no
	// supervisor remains, the pane root is the preserved interactive shell and
	// any child is a workload the operator launched from that shell.
	return hasChild && !hasSupervisor
}

func containsSupervisorForSession(entries []processEntry, rootPID int, sessionID string) bool {
	descendants := descendantPIDs(entries, rootPID)
	for _, entry := range entries {
		if entry.pid == rootPID || !descendants[entry.pid] {
			continue
		}
		fields := strings.Fields(entry.command)
		for i := 0; i+3 < len(fields); i++ {
			if fields[i] == "agent-process" && fields[i+1] == "supervise" &&
				fields[i+2] == "--session" && fields[i+3] == sessionID {
				return true
			}
		}
	}
	return false
}

func containsExactSupervisedWorkload(entries []processEntry, rootPID int, sessionID, launchID string) bool {
	descendants := descendantPIDs(entries, rootPID)
	supervisorPID := 0
	for _, entry := range entries {
		if entry.pid != rootPID && descendants[entry.pid] && isSupervisorCommand(entry.command, sessionID, launchID) {
			supervisorPID = entry.pid
			break
		}
	}
	if supervisorPID == 0 {
		return false
	}
	workloadDescendants := descendantPIDs(entries, supervisorPID)
	for _, entry := range entries {
		if entry.pid != supervisorPID && workloadDescendants[entry.pid] {
			return true
		}
	}
	return false
}

func isAnySupervisorCommand(command string) bool {
	fields := strings.Fields(command)
	for i := 0; i+1 < len(fields); i++ {
		if fields[i] == "agent-process" && fields[i+1] == "supervise" {
			return true
		}
	}
	return false
}

func isSupervisorCommand(command, sessionID, launchID string) bool {
	fields := strings.Fields(command)
	for i := 0; i+6 < len(fields); i++ {
		if fields[i] == "agent-process" && fields[i+1] == "supervise" &&
			fields[i+2] == "--session" && fields[i+3] == sessionID &&
			fields[i+4] == "--launch" && fields[i+5] == launchID && fields[i+6] == "--" {
			return true
		}
	}
	return false
}

// -- session name helpers --

func tmuxSessionName(id domain.SessionID) (string, error) {
	raw := string(id)
	if raw == "" {
		return "", errors.New("tmux runtime: session id is required")
	}
	return SessionName(raw), nil
}

// SessionName returns the tmux session name the runtime registers for a given
// session id, applying the same sanitisation Create does. Callers that print an
// attach hint must use this rather than the raw id.
func SessionName(id string) string {
	if sessionIDPattern.MatchString(id) && len(id) <= 48 {
		return id
	}
	return sanitizedSessionName(id)
}

func sanitizedSessionName(raw string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range raw {
		valid := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-'
		if valid {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "session"
	}
	if len(base) > 32 {
		base = strings.TrimRight(base[:32], "-")
	}
	sum := sha256.Sum256([]byte(raw))
	return base + "-" + hex.EncodeToString(sum[:4])
}

func handleID(handle ports.RuntimeHandle) (string, error) {
	id, _, _, err := parseRuntimeHandle(handle)
	return id, err
}

func parseRuntimeHandle(handle ports.RuntimeHandle) (id string, route sessionRoute, qualified bool, err error) {
	raw := strings.TrimSpace(handle.ID)
	if strings.HasPrefix(raw, qualifiedHandlePrefix+":") {
		parts := strings.Split(raw, ":")
		if len(parts) != 3 {
			return "", routePrivate, false, fmt.Errorf("tmux runtime: invalid qualified handle id %q", raw)
		}
		parsedRoute, ok := routeFromHandleName(parts[1])
		if !ok {
			return "", routePrivate, false, fmt.Errorf("tmux runtime: invalid qualified handle route %q", parts[1])
		}
		id, route, qualified = parts[2], parsedRoute, true
	} else {
		id = raw
	}
	if id == "" {
		return "", routePrivate, false, errors.New("tmux runtime: session id is required")
	}
	if !sessionIDPattern.MatchString(id) {
		return "", routePrivate, false, fmt.Errorf("tmux runtime: invalid handle id %q", raw)
	}
	return id, route, qualified, nil
}

func qualifiedRuntimeHandle(route sessionRoute, id string) ports.RuntimeHandle {
	return ports.RuntimeHandle{ID: qualifiedHandlePrefix + ":" + route.handleName() + ":" + id}
}

func (r *Runtime) resolveHandle(handle ports.RuntimeHandle) (string, error) {
	id, route, qualified, err := parseRuntimeHandle(handle)
	if err != nil {
		return "", err
	}
	if qualified {
		r.rememberSessionRoute(id, route, "")
	}
	return id, nil
}

// -- output detection helpers --

// sessionMissingOutput reports whether a non-zero `tmux has-session` exit is
// definitively "this session does not exist" — evidence about the probed
// session itself. Server-level failures deliberately do not match: "no server
// running" describes the whole server and "error connecting" is a transient
// socket failure; neither says anything about one session, so treating them as
// per-session death let a single server outage archive every session on the
// board (issue #3475).
func sessionMissingOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "can't find session") ||
		strings.Contains(s, "session not found")
}

// serverUnreachableOutput reports whether a non-zero tmux exit means the
// server itself could not be reached, which is inconclusive for any single
// session's liveness.
func serverUnreachableOutput(out string) bool {
	return serverNotRunningOutput(out) || transientServerFailureOutput(out)
}

func serverNotRunningOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "no server running")
}

func transientServerFailureOutput(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "error connecting") ||
		strings.Contains(s, "protocol version mismatch") ||
		strings.Contains(s, "server exited unexpectedly")
}

// killSessionMissingOutput reports whether a non-zero `tmux kill-session`
// failed because the session was already gone. Teardown stays generous: a
// missing server also means there is nothing left to kill, so it shares the
// server-level patterns that liveness probing must not use.
func killSessionMissingOutput(out string) bool {
	return sessionMissingOutput(out) || serverUnreachableOutput(out)
}

// -- text helpers --

func chunks(s string, maxBytes int) []string {
	if s == "" {
		return []string{""}
	}
	if maxBytes <= 0 || len(s) <= maxBytes {
		return []string{s}
	}
	parts := []string{}
	for s != "" {
		if len(s) <= maxBytes {
			parts = append(parts, s)
			break
		}
		end := maxBytes
		for end > 0 && !utf8.ValidString(s[:end]) {
			end--
		}
		if end == 0 {
			_, size := utf8.DecodeRuneInString(s)
			end = size
		}
		parts = append(parts, s[:end])
		s = s[end:]
	}
	return parts
}

func tailLines(s string, n int) string {
	if n <= 0 || s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) <= n {
		return s
	}
	return strings.Join(lines[len(lines)-n:], "")
}

func trimTrailingBlankLines(s string) string {
	if s == "" {
		return ""
	}
	lines := strings.SplitAfter(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for len(lines) > 0 && strings.TrimRight(lines[len(lines)-1], "\r\n") == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "")
}

// -- env / quoting helpers --

func validateEnvKeys(env map[string]string) error {
	for key := range env {
		if !validEnvKey(key) {
			return fmt.Errorf("tmux runtime: invalid env key %q", key)
		}
	}
	return nil
}

func validEnvKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') {
			continue
		}
		if i > 0 && r >= '0' && r <= '9' {
			continue
		}
		return false
	}
	return true
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
}

// buildLaunchCommand builds the shell command string passed to `sh -c`. The
// caller installs cfg.Env in tmux's session environment over stdin before this
// command is launched, so no configured values are embedded in process argv.
// Supervised launches park on a non-interpreting stdin sink after exit so bytes
// racing a process exit can never become shell commands; legacy/unsupervised
// launches retain the interactive-shell fallback used by manual recovery.
func buildLaunchCommand(cfg ports.RuntimeConfig) string {
	var b strings.Builder
	b.WriteString("cd ")
	b.WriteString(shellQuote(cfg.WorkspacePath))
	b.WriteString(" || exit; ")
	if _, configured := cfg.Env["NO_COLOR"]; !configured {
		// The daemon may be launched from another agent or CI environment that
		// sets NO_COLOR for its own captured output. Do not leak that ambient
		// preference into an interactive terminal session. A project can still
		// opt out of color explicitly through its configured environment.
		b.WriteString("unset NO_COLOR; ")
	}
	// The AO web terminal and tmux attach client both support 24-bit SGR color.
	// Keep this constant defense in the launch command as well as the session
	// environment so agent color detection cannot accidentally downgrade rich
	// syntax/diff colors to ANSI-256.
	b.WriteString("export COLORTERM='truecolor'; ")
	// Quote each argv word so spaces inside a word are preserved.
	parts := make([]string, len(cfg.Argv))
	for i, a := range cfg.Argv {
		parts[i] = shellQuote(a)
	}
	b.WriteString(strings.Join(parts, " "))
	if cfg.Env["AO_SUPERVISED_PROCESS"] == "1" {
		// cat consumes and discards any input that arrived while the supervised
		// child was exiting. Runtime Restart/Destroy replaces or kills the pane.
		b.WriteString(`; exec cat >/dev/null`)
	} else {
		// Keep the tmux session alive after an unsupervised agent exits so the
		// operator can inspect it and use the historical manual-recovery shell.
		b.WriteString(`; exec "${SHELL:-/bin/sh}" -i`)
	}
	return b.String()
}

func sameDirectory(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	absA, errA := filepath.Abs(a)
	if errA == nil {
		a = absA
	}
	absB, errB := filepath.Abs(b)
	if errB == nil {
		b = absB
	}
	if realA, err := filepath.EvalSymlinks(a); err == nil {
		a = realA
	}
	if realB, err := filepath.EvalSymlinks(b); err == nil {
		b = realB
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

// -- error type --

type commandError struct {
	err    error
	output string
}

func (e commandError) Error() string {
	if e.output == "" {
		return e.err.Error()
	}
	return e.err.Error() + ": " + e.output
}

func (e commandError) Unwrap() error { return e.err }

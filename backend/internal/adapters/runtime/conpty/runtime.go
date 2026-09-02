// runtime.go - conpty Runtime adapter. Implements ports.Runtime and
// ports.Attacher (see attach.go). Drives sessions via the B3 pty-host over
// loopback TCP, using the B1 protocol and the B2 registry for restart recovery.
package conpty

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/conpty/ptyregistry"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	runtimeLaunchIDEnv  = "AO_RUNTIME_LAUNCH_ID"
	runtimeSessionIDEnv = "AO_SESSION_ID"
	runtimeHostTokenEnv = "AO_PTY_HOST_TOKEN" // #nosec G101 -- environment variable name, not a credential
)

// Ensure Runtime satisfies the port at compile time (Attach in attach.go).
var _ ports.Runtime = (*Runtime)(nil)
var _ ports.StyledTerminalOutputReader = (*Runtime)(nil)
var _ ports.RuntimeHandleResolver = (*Runtime)(nil)
var _ ports.ExactRuntimeHandleResolver = (*Runtime)(nil)

// validSessionID matches agent-orchestrator's assertValidSessionId.
var validSessionID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// hostSession is the in-memory state for a live pty-host connection.
type hostSession struct {
	sessionID    string
	addr         string
	pid          int
	launchID     string
	hostToken    string
	registeredAt string
	legacyMu     sync.Mutex
	legacyProof  *legacyHostIdentityFingerprint
}

// Options configures the Runtime. All fields are optional; zero values use
// sensible defaults. The Spawner field is injectable for tests.
type Options struct {
	// Spawner overrides the default OS-level process spawner. If nil,
	// defaultSpawnHost is used (Windows-only; returns an error on other OSes).
	Spawner hostSpawner

	// RunFilePath is this daemon instance's running.json path (config.Config.
	// RunFilePath). It scopes the B2 pty-host registry to the same directory,
	// so two AO instances on one machine with different AO_RUN_FILE/
	// AO_DATA_DIR overrides never share one registry -- see
	// ptyregistry.SetRunFilePath. Empty uses the ~/.ao default.
	RunFilePath string
}

// Runtime is the conpty runtime adapter.
type Runtime struct {
	spawner     hostSpawner
	pidLiveness func(int) (bool, error)
	destroyWait time.Duration
	destroyPoll time.Duration
	// The legacy seams perform a one-time OS-level adoption proof for shipped
	// protocol-v2 hosts, then a cheap incarnation check on later operations.
	legacyCollector   func(context.Context, *hostSession, StatusPayload) (legacyHostIdentityEvidence, error)
	legacyRevalidator func(context.Context, *hostSession, StatusPayload, legacyHostIdentityFingerprint) error

	mu       sync.Mutex
	sessions map[string]*hostSession // sessionID -> live session
}

// New creates a Runtime with the given options.
func New(opts Options) *Runtime {
	ptyregistry.SetRunFilePath(opts.RunFilePath)
	sp := opts.Spawner
	if sp == nil {
		sp = defaultSpawnHost
	}
	return &Runtime{
		spawner:           sp,
		pidLiveness:       probePIDLiveness,
		destroyWait:       2 * time.Second,
		destroyPoll:       25 * time.Millisecond,
		legacyCollector:   collectLegacyHostIdentity,
		legacyRevalidator: revalidateLegacyHostIdentity,
		sessions:          make(map[string]*hostSession),
	}
}

func newHostToken() (string, error) {
	var token [32]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(token[:]), nil
}

// Create spawns a detached pty-host for the session, waits for READY, stores
// the addr+pid in-memory and in the B2 registry, and returns the handle.
// Returns an error if sessionID is invalid, already exists, or spawn fails.
func (r *Runtime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	id := string(cfg.SessionID)
	if !validSessionID.MatchString(id) {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: invalid session id %q: must match ^[a-zA-Z0-9_-]+$", id)
	}
	if cfg.WorkspacePath == "" {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: workspace path required")
	}
	if len(cfg.Argv) == 0 {
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: argv required")
	}
	if envSessionID := strings.TrimSpace(cfg.Env[runtimeSessionIDEnv]); envSessionID != "" {
		if envSessionID != id {
			return ports.RuntimeHandle{}, fmt.Errorf(
				"conpty: runtime session env %q does not match session %q: %w",
				envSessionID,
				id,
				ports.ErrRuntimeProbeInconclusive,
			)
		}
		if strings.TrimSpace(cfg.Env[runtimeLaunchIDEnv]) == "" {
			return ports.RuntimeHandle{}, fmt.Errorf(
				"conpty: managed session %q requires a runtime launch id: %w",
				id,
				ports.ErrRuntimeProbeInconclusive,
			)
		}
	}

	r.mu.Lock()
	if _, dup := r.sessions[id]; dup {
		r.mu.Unlock()
		return ports.RuntimeHandle{}, fmt.Errorf(
			"conpty: session %q already exists; destroy before re-creating: %w",
			id,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	// Reserve the slot before the async spawn so a concurrent Create for the
	// same id fails immediately (no gap between check and set).
	r.sessions[id] = nil
	r.mu.Unlock()

	// A detached host from an earlier daemon may already own this session id.
	// Read the durable registry before spawning so corrupt/unreadable state is
	// never interpreted as permission to create a duplicate workload. This
	// check is serialized within one daemon by the reservation above; the
	// run-file supervisor remains responsible for enforcing one daemon per
	// registry directory during process handoff.
	entries, registryErr := ptyregistry.List()
	if registryErr != nil {
		r.deleteSession(id, nil)
		return ports.RuntimeHandle{}, fmt.Errorf(
			"conpty: inspect pty-host registry before creating %q: %w",
			id,
			errors.Join(ports.ErrRuntimeProbeInconclusive, registryErr),
		)
	}
	for _, entry := range entries {
		if entry.SessionID != id {
			continue
		}
		existing := hostSessionFromRegistry(entry)
		host, alive, probeErr := r.connectVerifiedHost(ctx, existing, isAliveTimeout)
		if host != nil {
			_ = host.conn.Close()
		}
		if probeErr != nil {
			r.deleteSession(id, nil)
			return ports.RuntimeHandle{}, fmt.Errorf(
				"conpty: prove existing pty-host ownership for %q: %w",
				id,
				probeErr,
			)
		}
		if alive {
			r.deleteSession(id, nil)
			return ports.RuntimeHandle{}, fmt.Errorf(
				"conpty: detached pty-host already owns session %q: %w",
				id,
				ports.ErrRuntimeProbeInconclusive,
			)
		}
		// A dead recorded PID conclusively identifies the durable entry as
		// stale. Remove only that session entry before allocating its successor.
		if err := ptyregistry.UnregisterExact(entry); err != nil {
			r.deleteSession(id, nil)
			return ports.RuntimeHandle{}, fmt.Errorf(
				"conpty: remove exact dead pty-host registry entry for %q: %w",
				id,
				errors.Join(ports.ErrRuntimeProbeInconclusive, err),
			)
		}
	}

	hostToken, err := newHostToken()
	if err != nil {
		r.deleteSession(id, nil)
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: generate pty-host identity for %q: %w", id, err)
	}
	hostEnv := make(map[string]string, len(cfg.Env)+1)
	for key, value := range cfg.Env {
		hostEnv[key] = value
	}
	hostEnv[runtimeHostTokenEnv] = hostToken

	addr, pid, err := r.spawner(ctx, id, cfg.WorkspacePath, cfg.Argv, hostEnv)
	if err != nil {
		r.deleteSession(id, nil)
		return ports.RuntimeHandle{}, fmt.Errorf("conpty: spawn pty-host for %q: %w", id, err)
	}

	sess := &hostSession{
		sessionID:    id,
		addr:         addr,
		pid:          pid,
		launchID:     strings.TrimSpace(cfg.Env[runtimeLaunchIDEnv]),
		hostToken:    hostToken,
		registeredAt: time.Now().UTC().Format(time.RFC3339Nano),
	}

	r.mu.Lock()
	r.sessions[id] = sess
	r.mu.Unlock()

	// The host is not publishable until its recovery record is durable. If the
	// write fails, stop the just-spawned host before returning so the caller can
	// never receive a handle that disappears (or duplicates) after a restart.
	entry := registryEntryForSession(sess)
	if err := ptyregistry.RegisterIfAbsent(entry); err != nil {
		registrationErr := fmt.Errorf(
			"conpty: durably register pty-host for %q: %w",
			id,
			errors.Join(ports.ErrRuntimeProbeInconclusive, err),
		)
		stopped, rollbackErr := r.stopHost(context.Background(), sess)
		if stopped {
			if unregisterErr := ptyregistry.UnregisterExact(entry); unregisterErr != nil &&
				!errors.Is(unregisterErr, ptyregistry.ErrEntryChanged) {
				rollbackErr = errors.Join(
					rollbackErr,
					fmt.Errorf("remove partially published registry entry: %w", unregisterErr),
				)
			}
			r.deleteSession(id, sess)
		}
		if rollbackErr != nil {
			return ports.RuntimeHandle{}, errors.Join(
				registrationErr,
				fmt.Errorf("conpty: roll back unregistered pty-host for %q: %w", id, rollbackErr),
			)
		}
		return ports.RuntimeHandle{}, registrationErr
	}

	return ports.RuntimeHandle{ID: id}, nil
}

// Destroy gracefully stops an authenticated pty-host. It never force-kills a
// bare PID because process-id reuse would make that unsafe.
// The session remains registered until its PID is confirmed gone so callers
// never receive a false-success teardown while a provider may still be alive.
// Unknown/already-gone sessions remain idempotent.
func (r *Runtime) Destroy(ctx context.Context, handle ports.RuntimeHandle) error {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return fmt.Errorf("conpty: resolve session %q for destroy: %w", handle.ID, err)
	}
	if sess == nil {
		return nil // unknown or already gone
	}
	stopped, err := r.stopHost(ctx, sess)
	if err != nil {
		return err
	}
	if !stopped {
		return fmt.Errorf("conpty: pty-host pid %d was not stopped", sess.pid)
	}

	if err := ptyregistry.UnregisterExact(registryEntryForSession(sess)); err != nil {
		if errors.Is(err, ptyregistry.ErrEntryChanged) {
			// Drop only our stale in-memory route. The changed durable owner is
			// preserved and will be resolved on the next operation.
			r.deleteSession(handle.ID, sess)
		}
		return fmt.Errorf(
			"conpty: unregister exact destroyed session %q: %w",
			handle.ID,
			errors.Join(ports.ErrRuntimeProbeInconclusive, err),
		)
	}
	r.deleteSession(handle.ID, sess)
	return nil
}

func (r *Runtime) stopHost(ctx context.Context, sess *hostSession) (bool, error) {
	host, alive, err := r.connectVerifiedHost(ctx, sess, isAliveTimeout)
	if err != nil {
		return false, fmt.Errorf("conpty: authenticate pty-host before teardown: %w", err)
	}
	if !alive {
		return true, nil
	}
	defer func() { _ = host.conn.Close() }()
	// Keep authentication and the mutation on one TCP connection. A separate
	// dial would reopen a port-reuse race between ownership proof and KILL.
	if err := clientKillConn(host.conn); err != nil {
		return false, err
	}
	exited, waitErr := r.waitForPIDExit(ctx, sess.pid)
	if waitErr != nil {
		return false, waitErr
	}
	if !exited {
		// Never force-kill by a bare PID. The original host may have exited and
		// that PID may now name an unrelated process; preserving the registry is
		// safer than turning an inconclusive teardown into foreign termination.
		return false, fmt.Errorf(
			"conpty: authenticated pty-host pid %d did not exit after teardown: %w",
			sess.pid,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	return true, nil
}

// deleteSession releases either an in-progress reservation (expected nil) or
// one exact host. Pointer matching prevents cleanup from deleting a later host
// if lifecycle operations race.
func (r *Runtime) deleteSession(id string, expected *hostSession) {
	r.mu.Lock()
	if current, ok := r.sessions[id]; ok && current == expected {
		delete(r.sessions, id)
	}
	r.mu.Unlock()
}

func (r *Runtime) waitForPIDExit(ctx context.Context, pid int) (bool, error) {
	alive, err := r.probePIDLiveness(pid)
	if err != nil {
		return false, err
	}
	if !alive {
		return true, nil
	}
	wait := r.destroyWait
	if wait <= 0 {
		return false, nil
	}
	poll := r.destroyPoll
	if poll <= 0 {
		poll = 25 * time.Millisecond
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-timer.C:
			alive, err := r.probePIDLiveness(pid)
			if err != nil {
				return false, err
			}
			return !alive, nil
		case <-ticker.C:
			alive, err := r.probePIDLiveness(pid)
			if err != nil {
				return false, err
			}
			if !alive {
				return true, nil
			}
		}
	}
}

func (r *Runtime) probePIDLiveness(pid int) (bool, error) {
	alive, err := r.pidLiveness(pid)
	if err != nil {
		return false, fmt.Errorf(
			"conpty: probe pty-host pid %d: %w",
			pid,
			errors.Join(ports.ErrRuntimeProbeInconclusive, err),
		)
	}
	return alive, nil
}

// IsAlive distinguishes three outcomes so the reaper never spuriously reaps a
// live session on a transient probe failure:
//
//   - (true, nil):  the pty-host answered a status probe -> alive.
//   - (false, nil): DEFINITIVELY gone. Either the session resolves to nothing
//     (no in-memory entry and no registry entry), or the recorded PID is gone.
//   - (false, err): a TRANSIENT probe failure (loopback timeout, connected-
//     then-failed I/O). The reaper records ProbeFailed and retries rather than
//     treating it as a death conclusion.
//
// tmux returns a non-nil error for transient failures for the same
// reason; conpty matches that contract here.
func (r *Runtime) IsAlive(ctx context.Context, handle ports.RuntimeHandle) (bool, error) {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return false, err
	}
	if sess == nil {
		return false, nil // no in-memory entry, no registry entry -> definitively gone
	}
	host, alive, err := r.connectVerifiedHost(ctx, sess, isAliveTimeout)
	if host != nil {
		_ = host.conn.Close()
	}
	return alive, err
}

// IsSupervisedProcessAlive uses the pty-host's child status. For a supervised
// launch that child is the AO supervisor, whose lifetime matches the managed
// agent process. When a generation ref is supplied, the launch id captured at
// Create (and persisted in the recovery registry) must match exactly.
func (r *Runtime) IsSupervisedProcessAlive(ctx context.Context, handle ports.RuntimeHandle, ref ports.SupervisedProcessRef) (bool, error) {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return false, err
	}
	if sess == nil {
		return false, nil
	}
	if ref.SessionID != "" && string(ref.SessionID) != handle.ID {
		return false, fmt.Errorf(
			"conpty: runtime handle %q does not match supervised owner session %q: %w",
			handle.ID,
			ref.SessionID,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	if ref.LaunchID != "" && (sess.launchID == "" || sess.launchID != ref.LaunchID) {
		return false, fmt.Errorf(
			"conpty: runtime handle %q launch ownership does not match: %w",
			handle.ID,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	host, hostAlive, err := r.connectVerifiedHost(ctx, sess, isAliveTimeout)
	if err != nil {
		return false, err
	}
	if !hostAlive {
		return false, nil
	}
	defer func() { _ = host.conn.Close() }()
	return host.status.Alive, nil
}

// IsExactSupervisedProcessAlive has the same implementation on ConPTY because
// the pty-host registry already fences its one child by the exact launch id.
func (r *Runtime) IsExactSupervisedProcessAlive(ctx context.Context, handle ports.RuntimeHandle, ref ports.SupervisedProcessRef) (bool, error) {
	if ref.SessionID == "" || ref.LaunchID == "" {
		return false, errors.New("conpty: exact supervisor session and launch are required")
	}
	return r.IsSupervisedProcessAlive(ctx, handle, ref)
}

// ResolveRuntimeHandle proves that a persisted native handle still resolves to
// the exact detached host generation owned by the session. A launch mismatch
// is unknown ownership, not evidence that the old workload is dead: recovery
// must stop rather than start a duplicate process behind the same handle.
func (r *Runtime) ResolveRuntimeHandle(ctx context.Context, handle ports.RuntimeHandle, owner ports.SupervisedProcessRef) (ports.RuntimeHandle, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.RuntimeHandle{}, false, err
	}
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return ports.RuntimeHandle{}, false, err
	}
	if sess == nil {
		return ports.RuntimeHandle{}, false, nil
	}
	if owner.SessionID == "" || string(owner.SessionID) != handle.ID {
		return ports.RuntimeHandle{}, false, fmt.Errorf(
			"conpty: persisted handle %q does not match owner session %q: %w",
			handle.ID,
			owner.SessionID,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	if owner.LaunchID == "" || sess.launchID == "" || sess.launchID != owner.LaunchID {
		return ports.RuntimeHandle{}, false, fmt.Errorf(
			"conpty: persisted handle %q launch ownership does not match: %w",
			handle.ID,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	host, alive, err := r.connectVerifiedHost(ctx, sess, isAliveTimeout)
	if host != nil {
		_ = host.conn.Close()
	}
	if err != nil || !alive {
		return ports.RuntimeHandle{}, false, err
	}
	return handle, true, nil
}

// ResolveExactRuntimeHandle uses the same immutable launch proof for native
// hosts. Unlike tmux, a pty-host has one registry route and one child, so
// recovery adoption and destructive cleanup share the exact same resolver.
func (r *Runtime) ResolveExactRuntimeHandle(ctx context.Context, handle ports.RuntimeHandle, owner ports.SupervisedProcessRef) (ports.RuntimeHandle, bool, error) {
	return r.ResolveRuntimeHandle(ctx, handle, owner)
}

// SendMessage chunks message and writes it to the pty-host followed by Enter.
func (r *Runtime) SendMessage(ctx context.Context, handle ports.RuntimeHandle, message string) error {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	host, alive, err := r.connectVerifiedHost(ctx, sess, dialTimeout)
	if err != nil {
		return err
	}
	if !alive {
		return fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	defer func() { _ = host.conn.Close() }()
	return clientSendMessageConn(host.conn, message)
}

// Interrupt sends Ctrl-C to the PTY without tearing down the terminal host.
func (r *Runtime) Interrupt(ctx context.Context, handle ports.RuntimeHandle) error {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	return r.sendInputToExactHost(ctx, handle.ID, sess, "\x03")
}

// SendInput writes raw terminal input without appending Enter. It is intended
// for TUI keybindings such as Escape rather than prompt text.
func (r *Runtime) SendInput(ctx context.Context, handle ports.RuntimeHandle, input string) error {
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	return r.sendInputToExactHost(ctx, handle.ID, sess, input)
}

func (r *Runtime) sendInputToExactHost(ctx context.Context, id string, sess *hostSession, input string) error {
	host, alive, err := r.connectVerifiedHost(ctx, sess, dialTimeout)
	if err != nil {
		return err
	}
	if !alive {
		return fmt.Errorf("conpty: session %q not found", id)
	}
	defer func() { _ = host.conn.Close() }()
	return clientSendInputConn(host.conn, input)
}

// GetOutput returns the last lines lines from the pty-host ring buffer.
func (r *Runtime) GetOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	if lines <= 0 {
		return "", fmt.Errorf("conpty: lines must be > 0")
	}
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return "", err
	}
	if sess == nil {
		return "", fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	host, alive, err := r.connectVerifiedHost(ctx, sess, getOutputTimeout)
	if err != nil {
		return "", err
	}
	if !alive {
		return "", fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	defer func() { _ = host.conn.Close() }()
	stopCancellation := armClientDeadline(ctx, host.conn, getOutputTimeout)
	defer stopCancellation()
	return clientReadOutputConnWithPending(
		ctx, host.conn, host.pending, lines, MsgGetOutputReq, MsgGetOutputRes,
	)
}

// GetStyledOutput returns the current rendered ConPTY viewport with ANSI cell
// styles preserved. The pty-host owns the screen model so this remains valid
// across daemon restarts and never substitutes the raw scrollback ring.
func (r *Runtime) GetStyledOutput(ctx context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	if lines <= 0 {
		return "", fmt.Errorf("conpty: lines must be > 0")
	}
	sess, err := r.resolve(handle.ID)
	if err != nil {
		return "", err
	}
	if sess == nil {
		return "", fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	host, alive, err := r.connectVerifiedHost(ctx, sess, getOutputTimeout)
	if err != nil {
		return "", err
	}
	if !alive {
		return "", fmt.Errorf("conpty: session %q not found", handle.ID)
	}
	defer func() { _ = host.conn.Close() }()
	if host.status.ProtocolVersion < conPTYStyledOutputProtocolVersion {
		return "", fmt.Errorf("conpty: pty-host protocol version %d: %w",
			host.status.ProtocolVersion, ports.ErrStyledTerminalOutputUnavailable)
	}
	stopCancellation := armClientDeadline(ctx, host.conn, getOutputTimeout)
	defer stopCancellation()
	return clientReadOutputConnWithPending(
		ctx, host.conn, host.pending, lines, MsgGetStyledOutputReq, MsgGetStyledOutputRes,
	)
}

type verifiedHostConnection struct {
	conn          net.Conn
	status        StatusPayload
	initialFrames []clientFrame
	pending       []byte
}

// connectVerifiedHost proves the endpoint against all immutable identity
// fields before returning the same connection for use. A recorded PID that is
// gone is conclusive death; a live PID by itself proves nothing, so any
// missing credential, unreachable address, or identity mismatch fails closed.
func (r *Runtime) connectVerifiedHost(ctx context.Context, sess *hostSession, timeout time.Duration) (*verifiedHostConnection, bool, error) {
	if sess == nil {
		return nil, false, nil
	}
	if sess.pid <= 0 || strings.TrimSpace(sess.sessionID) == "" || strings.TrimSpace(sess.addr) == "" {
		return nil, false, fmt.Errorf(
			"conpty: incomplete pty-host recovery identity: %w",
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	pidAlive, err := r.probePIDLiveness(sess.pid)
	if err != nil {
		return nil, false, err
	}
	if !pidAlive {
		return nil, false, nil
	}
	probe, err := clientStatusConnectionContext(ctx, sess.addr, timeout)
	if err != nil {
		return nil, false, fmt.Errorf(
			"conpty: probe exact pty-host %q: %w",
			sess.sessionID,
			errors.Join(ports.ErrRuntimeProbeInconclusive, err),
		)
	}
	if !probe.reachable {
		return nil, false, fmt.Errorf(
			"conpty: pty-host %q address is unreachable while recorded pid %d is live: %w",
			sess.sessionID,
			sess.pid,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	if strings.TrimSpace(sess.hostToken) == "" {
		if probe.status.ProtocolVersion != conPTYStyledOutputProtocolVersion {
			_ = probe.conn.Close()
			return nil, false, fmt.Errorf(
				"conpty: pty-host %q has no durable identity token and unsupported legacy protocol %d: %w",
				sess.sessionID,
				probe.status.ProtocolVersion,
				ports.ErrRuntimeProbeInconclusive,
			)
		}
		if r.legacyCollector == nil || r.legacyRevalidator == nil {
			_ = probe.conn.Close()
			return nil, false, fmt.Errorf(
				"conpty: no legacy identity verifier for pty-host %q: %w",
				sess.sessionID,
				ports.ErrRuntimeProbeInconclusive,
			)
		}
		if err := r.verifyLegacyHostIdentity(ctx, sess, probe.status); err != nil {
			_ = probe.conn.Close()
			return nil, false, fmt.Errorf(
				"conpty: verify shipped protocol-v2 pty-host %q: %w",
				sess.sessionID,
				errors.Join(ports.ErrRuntimeProbeInconclusive, err),
			)
		}
	} else if probe.status.ProtocolVersion < conPTYHostIdentityProtocolVersion ||
		probe.status.SessionID != sess.sessionID ||
		probe.status.LaunchID != sess.launchID ||
		probe.status.HostPID != sess.pid ||
		subtle.ConstantTimeCompare([]byte(probe.status.HostToken), []byte(sess.hostToken)) != 1 {
		_ = probe.conn.Close()
		return nil, false, fmt.Errorf(
			"conpty: endpoint for %q does not match its durable host identity: %w",
			sess.sessionID,
			ports.ErrRuntimeProbeInconclusive,
		)
	}
	return &verifiedHostConnection{
		conn:          probe.conn,
		status:        probe.status,
		initialFrames: probe.frames,
		pending:       probe.pending,
	}, true, nil
}

func hostSessionFromRegistry(entry ptyregistry.Entry) *hostSession {
	return &hostSession{
		sessionID:    entry.SessionID,
		addr:         entry.PipePath,
		pid:          entry.PtyHostPID,
		launchID:     entry.LaunchID,
		hostToken:    entry.HostToken,
		registeredAt: entry.RegisteredAt,
	}
}

func registryEntryForSession(sess *hostSession) ptyregistry.Entry {
	return ptyregistry.Entry{
		SessionID:    sess.sessionID,
		PtyHostPID:   sess.pid,
		PipePath:     sess.addr,
		LaunchID:     sess.launchID,
		HostToken:    sess.hostToken,
		RegisteredAt: sess.registeredAt,
	}
}

// resolve looks up a session by id: first the in-memory map, then the B2
// registry (for daemon-restart recovery). Returns nil if not found either way.
func (r *Runtime) resolve(id string) (*hostSession, error) {
	r.mu.Lock()
	sess := r.sessions[id]
	r.mu.Unlock()
	if sess != nil {
		return sess, nil
	}

	// Registry fallback: scan for the entry by session id.
	entries, err := ptyregistry.List()
	if err != nil {
		return nil, fmt.Errorf(
			"conpty: read pty-host registry for %q: %w",
			id,
			errors.Join(ports.ErrRuntimeProbeInconclusive, err),
		)
	}
	for _, e := range entries {
		if e.SessionID != id {
			continue
		}
		// Re-populate the map so subsequent calls skip the file scan.
		recovered := hostSessionFromRegistry(e)
		r.mu.Lock()
		// Only store if another goroutine hasn't beaten us.
		if r.sessions[id] == nil {
			r.sessions[id] = recovered
		} else {
			recovered = r.sessions[id]
		}
		r.mu.Unlock()
		return recovered, nil
	}
	return nil, nil
}

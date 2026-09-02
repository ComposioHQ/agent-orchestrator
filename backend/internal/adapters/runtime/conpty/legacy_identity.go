package conpty

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// protocol-v2 hosts shipped before authenticated status responses. They
// cannot be taught a token after they already own a live PTY, so upgrade
// recovery proves the immutable OS process incarnation and its listener
// instead. New hosts never use this path.
const legacyRegistrationWindow = 30 * time.Second

type legacyProcessIdentity struct {
	pid        int
	ppid       int
	startedAt  time.Time
	executable string
	argv       []string
}

type legacyHostIdentityEvidence struct {
	listenerPID int
	host        legacyProcessIdentity
	child       *legacyProcessIdentity
}

type legacyHostIdentityFingerprint struct {
	hostPID        int
	hostStartedAt  time.Time
	childPID       int
	childStartedAt time.Time
}

func (r *Runtime) verifyLegacyHostIdentity(ctx context.Context, sess *hostSession, status StatusPayload) error {
	if err := validateLegacyStatusEnvelope(status); err != nil {
		return err
	}
	verifyCtx, cancel := context.WithTimeout(ctx, isAliveTimeout)
	defer cancel()

	sess.legacyMu.Lock()
	defer sess.legacyMu.Unlock()
	if sess.legacyProof != nil {
		return r.legacyRevalidator(verifyCtx, sess, status, *sess.legacyProof)
	}
	evidence, err := r.legacyCollector(verifyCtx, sess, status)
	if err != nil {
		return err
	}
	if err := validateLegacyHostIdentity(sess, status, evidence); err != nil {
		return err
	}
	proof := legacyHostIdentityFingerprint{
		hostPID:       evidence.host.pid,
		hostStartedAt: evidence.host.startedAt,
	}
	if evidence.child != nil {
		proof.childPID = evidence.child.pid
		proof.childStartedAt = evidence.child.startedAt
	}
	sess.legacyProof = &proof
	return nil
}

func validateLegacyHostIdentity(sess *hostSession, status StatusPayload, evidence legacyHostIdentityEvidence) error {
	if err := validateLegacyStatusEnvelope(status); err != nil {
		return err
	}
	if evidence.listenerPID != sess.pid {
		return fmt.Errorf("listener owner pid = %d, want recorded host pid %d", evidence.listenerPID, sess.pid)
	}
	if evidence.host.pid != sess.pid {
		return fmt.Errorf("host process pid = %d, want %d", evidence.host.pid, sess.pid)
	}
	if !isAOExecutable(evidence.host.executable) {
		return fmt.Errorf("host executable %q is not AO", evidence.host.executable)
	}
	if len(evidence.host.argv) < 4 ||
		!isAOExecutable(evidence.host.argv[0]) ||
		evidence.host.argv[1] != "pty-host" ||
		evidence.host.argv[2] != sess.sessionID {
		return fmt.Errorf("host argv does not identify pty-host session %q", sess.sessionID)
	}
	if sessionID, launchID, found := supervisedOwnerFromArgv(evidence.host.argv[4:]); sess.launchID != "" {
		if !found || sessionID != sess.sessionID || launchID != sess.launchID {
			return fmt.Errorf("host supervisor argv does not match session/launch ownership")
		}
	} else if found && (sessionID != sess.sessionID || launchID != "") {
		return fmt.Errorf("host supervisor argv does not match auxiliary session ownership")
	}

	registeredAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(sess.registeredAt))
	if err != nil {
		return fmt.Errorf("parse legacy registry timestamp %q: %w", sess.registeredAt, err)
	}
	if evidence.host.startedAt.IsZero() {
		return fmt.Errorf("host process start time is unavailable")
	}
	// Registry publication follows READY immediately. Allow sub-second
	// truncation to put the RFC3339 value just before process creation, but a
	// materially different time means this PID belongs to a later incarnation.
	if registeredAt.Before(evidence.host.startedAt.Add(-time.Second)) ||
		registeredAt.After(evidence.host.startedAt.Add(legacyRegistrationWindow)) {
		return fmt.Errorf(
			"host process start %s does not match registry publication %s",
			evidence.host.startedAt.UTC().Format(time.RFC3339Nano),
			registeredAt.UTC().Format(time.RFC3339Nano),
		)
	}

	if status.Alive {
		if status.PID <= 0 || evidence.child == nil {
			return fmt.Errorf("live legacy host did not yield child process identity")
		}
		if evidence.child.pid != status.PID || evidence.child.ppid != sess.pid {
			return fmt.Errorf(
				"status child pid %d is not parented by recorded host pid %d",
				status.PID,
				sess.pid,
			)
		}
		if evidence.child.startedAt.Before(evidence.host.startedAt) {
			return fmt.Errorf("status child predates its recorded pty-host")
		}
		if sess.launchID != "" && !isAOExecutable(evidence.child.executable) {
			return fmt.Errorf("status child executable %q is not AO supervisor", evidence.child.executable)
		}
		if sessionID, launchID, found := supervisedOwnerFromArgv(evidence.child.argv); sess.launchID != "" {
			if !found || sessionID != sess.sessionID || launchID != sess.launchID {
				return fmt.Errorf("status child supervisor argv does not match session/launch ownership")
			}
		} else if found && (sessionID != sess.sessionID || launchID != "") {
			return fmt.Errorf("status child supervisor argv does not match auxiliary session ownership")
		}
	}
	return nil
}

func validateLegacyStatusEnvelope(status StatusPayload) error {
	if status.ProtocolVersion != conPTYStyledOutputProtocolVersion {
		return fmt.Errorf("legacy protocol version = %d, want %d", status.ProtocolVersion, conPTYStyledOutputProtocolVersion)
	}
	if status.SessionID != "" || status.LaunchID != "" || status.HostPID != 0 || status.HostToken != "" {
		return fmt.Errorf("legacy status unexpectedly contains partial authenticated identity")
	}
	return nil
}

func isAOExecutable(path string) bool {
	name := strings.ToLower(filepath.Base(strings.TrimSpace(path)))
	name = strings.TrimSuffix(name, ".exe")
	return name == "ao" || name == "agent-orchestrator"
}

func supervisedOwnerFromArgv(argv []string) (sessionID, launchID string, found bool) {
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] != "agent-process" || argv[i+1] != "supervise" {
			continue
		}
		for j := i + 2; j+1 < len(argv); j++ {
			switch argv[j] {
			case "--session":
				sessionID = argv[j+1]
				j++
			case "--launch":
				launchID = argv[j+1]
				j++
			case "--":
				return sessionID, launchID, true
			}
		}
		return sessionID, launchID, true
	}
	return "", "", false
}

package sessionmanager

import (
	"context"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/portscan"
)

// ChatProcessLocator is an optional ChatLauncher capability: the live provider
// process for a chat session, and whether there is one. Kept separate from
// ChatLauncher itself so focused chat fakes do not have to grow a method for a
// purely observational read.
type ChatProcessLocator interface {
	ChatProcessID(id domain.SessionID) (int, bool)
}

// ListDescendantPorts reports the TCP ports one session is serving on, so the
// desktop can offer them as preview suggestions.
//
// Detection is anchored two ways, and a process counts on either: it is under
// the session's own root process, or its working directory is inside the
// session's worktree. Both are needed. The root process differs by mode -- a
// terminal session's work hangs off its runtime (a tmux pane's shell), while a
// chat session has no runtime handle at all and hangs off the provider process
// the chat controller owns -- and neither survives an agent backgrounding a dev
// server, which detaches it from every AO-owned parent. The worktree does not
// move and belongs to exactly one session, so it keeps the scan scoped when the
// process tree no longer can.
//
// Detection is best effort in every mode. A missing capability, a session with
// no live process, a terminated session, and a failed scan all yield an empty
// list rather than an error, because "no suggestions" is a normal outcome the
// desktop already renders. Only an unreadable store or an unknown session id is
// an error: those describe a bad request, not absent detection.
func (m *Manager) ListDescendantPorts(ctx context.Context, id domain.SessionID) ([]ports.DetectedPort, error) {
	rec, ok, err := m.store.GetSession(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("list descendant ports %s: %w", id, err)
	}
	if !ok {
		return nil, ErrNotFound
	}
	// A terminated session's recorded handle may already have been recycled by
	// the runtime, and its worktree may be gone or reassigned.
	if rec.IsTerminated {
		return nil, nil
	}
	rootPID := m.sessionRootProcess(ctx, rec)
	workspace := strings.TrimSpace(rec.Metadata.WorkspacePath)
	if rootPID <= 0 && workspace == "" {
		return nil, nil
	}
	detected := portscan.Detect(ctx, rootPID, workspace)
	out := make([]ports.DetectedPort, 0, len(detected))
	for _, port := range detected {
		out = append(out, ports.DetectedPort{Port: port.Port, PID: port.PID, Command: port.Command})
	}
	return out, nil
}

// sessionRootProcess is the process a session's own work hangs off, or 0 when
// there is none to point at. Chat sessions get it from the chat controller
// (their provider is a child of the daemon, not of any runtime); every other
// mode gets it from the runtime adapter.
func (m *Manager) sessionRootProcess(ctx context.Context, rec domain.SessionRecord) int {
	if rec.Mode == domain.SessionModeChat {
		if m.chat == nil {
			return 0
		}
		locator, ok := m.chat.(ChatProcessLocator)
		if !ok {
			return 0
		}
		pid, ok := locator.ChatProcessID(rec.ID)
		if !ok {
			return 0
		}
		return pid
	}
	inspector, ok := m.runtime.(ports.SessionRootProcessInspector)
	if !ok || strings.TrimSpace(rec.Metadata.RuntimeHandleID) == "" {
		return 0
	}
	pid, err := inspector.RootProcessID(ctx, runtimeHandle(rec.Metadata))
	if err != nil {
		return 0
	}
	return pid
}

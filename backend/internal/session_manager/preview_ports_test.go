package sessionmanager

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// rootProcessRuntime is a runtime that implements the optional root-process
// capability, and records whether the manager reached for it.
type rootProcessRuntime struct {
	*fakeRuntime
	calls []ports.RuntimeHandle
	pid   int
	err   error
}

func (r *rootProcessRuntime) RootProcessID(_ context.Context, handle ports.RuntimeHandle) (int, error) {
	r.calls = append(r.calls, handle)
	return r.pid, r.err
}

// chatPortLauncher is a chat launcher that also reports its provider process.
type chatPortLauncher struct {
	*recordingLauncher
	pid     int
	hasPID  bool
	lookups []domain.SessionID
}

func (l *chatPortLauncher) ChatProcessID(id domain.SessionID) (int, bool) {
	l.lookups = append(l.lookups, id)
	return l.pid, l.hasPID
}

func seedPortSession(st *fakeStore, id domain.SessionID, mode domain.SessionMode, handleID, workspace string) {
	st.sessions[id] = domain.SessionRecord{
		ID:        id,
		ProjectID: chatTestProject,
		Mode:      mode,
		Metadata:  domain.SessionMetadata{RuntimeHandleID: handleID, WorkspacePath: workspace},
	}
}

// A terminal session's work hangs off its runtime handle, so the runtime is
// what knows the root process.
func TestListDescendantPortsRootsTerminalSessionsAtTheRuntime(t *testing.T) {
	launcher := &chatPortLauncher{recordingLauncher: &recordingLauncher{}}
	m, st, rt := newChatManager(launcher)
	inspector := &rootProcessRuntime{fakeRuntime: rt, pid: 4242}
	m.runtime = inspector
	seedPortSession(st, "sess-tui", domain.SessionModeTUI, "handle-1", "")

	if _, err := m.ListDescendantPorts(t.Context(), "sess-tui"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(inspector.calls) != 1 || inspector.calls[0].ID != "handle-1" {
		t.Fatalf("runtime calls = %#v", inspector.calls)
	}
	if len(launcher.lookups) != 0 {
		t.Fatal("a terminal session asked the chat launcher for a process")
	}
}

// A chat session has no runtime handle at all: its provider is a child of the
// daemon, so the chat controller owns the only usable root. Asking the runtime
// instead is what made chat sessions detect nothing.
func TestListDescendantPortsRootsChatSessionsAtTheProvider(t *testing.T) {
	launcher := &chatPortLauncher{recordingLauncher: &recordingLauncher{}, pid: 4242, hasPID: true}
	m, st, rt := newChatManager(launcher)
	inspector := &rootProcessRuntime{fakeRuntime: rt, pid: 99}
	m.runtime = inspector
	seedPortSession(st, "sess-chat", domain.SessionModeChat, "", "")

	if _, err := m.ListDescendantPorts(t.Context(), "sess-chat"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(launcher.lookups) != 1 || launcher.lookups[0] != "sess-chat" {
		t.Fatalf("chat lookups = %#v", launcher.lookups)
	}
	if len(inspector.calls) != 0 {
		t.Fatalf("a chat session was rooted through the runtime: %#v", inspector.calls)
	}
}

// Every "cannot detect" shape is an empty list, never an error: the desktop
// renders no suggestions for all of them, and an error would be noise.
func TestListDescendantPortsFailOpen(t *testing.T) {
	for name, tc := range map[string]struct {
		mode       domain.SessionMode
		handleID   string
		terminated bool
		hasPID     bool
		rootErr    error
		plainRT    bool
	}{
		"chat session with no live provider":    {mode: domain.SessionModeChat},
		"terminal session with no handle yet":   {mode: domain.SessionModeTUI},
		"runtime without the capability":        {mode: domain.SessionModeTUI, handleID: "handle-1", plainRT: true},
		"root process lookup failed":            {mode: domain.SessionModeTUI, handleID: "handle-1", rootErr: errors.New("no tmux")},
		"terminated session is never scanned":   {mode: domain.SessionModeTUI, handleID: "handle-1", terminated: true},
		"terminated chat session is not probed": {mode: domain.SessionModeChat, terminated: true, hasPID: true},
	} {
		t.Run(name, func(t *testing.T) {
			launcher := &chatPortLauncher{recordingLauncher: &recordingLauncher{}, hasPID: tc.hasPID}
			m, st, rt := newChatManager(launcher)
			if !tc.plainRT {
				m.runtime = &rootProcessRuntime{fakeRuntime: rt, err: tc.rootErr}
			}
			// No workspace path either, so nothing is left to anchor a scan to.
			seedPortSession(st, "sess-1", tc.mode, tc.handleID, "")
			if tc.terminated {
				rec := st.sessions["sess-1"]
				rec.IsTerminated = true
				st.sessions["sess-1"] = rec
			}

			got, err := m.ListDescendantPorts(t.Context(), "sess-1")
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != 0 {
				t.Fatalf("ports = %#v, want none", got)
			}
			if tc.terminated && len(launcher.lookups) != 0 {
				t.Fatal("a terminated session was probed for a live process")
			}
		})
	}
}

// An agent that backgrounds a dev server detaches it from every AO-owned
// parent, so a session whose root process is gone must still scan on its
// worktree alone rather than giving up.
func TestListDescendantPortsScansOnWorkspaceWithoutARootProcess(t *testing.T) {
	launcher := &chatPortLauncher{recordingLauncher: &recordingLauncher{}}
	m, st, rt := newChatManager(launcher)
	m.runtime = &rootProcessRuntime{fakeRuntime: rt, err: errors.New("pane is gone")}
	seedPortSession(st, "sess-1", domain.SessionModeTUI, "handle-1", t.TempDir())

	// The scan itself finds nothing for an empty temp dir; what matters is that
	// it ran instead of short-circuiting on the missing root.
	if _, err := m.ListDescendantPorts(t.Context(), "sess-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// An unknown session is a bad request, not absent detection, so it stays an
// error the API can turn into a 404.
func TestListDescendantPortsUnknownSession(t *testing.T) {
	m, _, _ := newChatManager(&chatPortLauncher{recordingLauncher: &recordingLauncher{}})

	if _, err := m.ListDescendantPorts(t.Context(), "missing-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

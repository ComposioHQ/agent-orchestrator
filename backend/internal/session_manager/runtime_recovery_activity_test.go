package sessionmanager

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recoverySurfaceRuntime struct {
	*fakeRuntime
	styledOutput string
}

func (r *recoverySurfaceRuntime) GetStyledOutput(
	context.Context,
	ports.RuntimeHandle,
	int,
) (string, error) {
	return r.styledOutput, nil
}

type recoverySurfaceAgent struct {
	fakeAgent
	work ports.TerminalSurfaceWorkState
}

func (a recoverySurfaceAgent) InspectTerminalSurface(string) ports.TerminalSurfaceObservation {
	return ports.TerminalSurfaceObservation{Work: a.work}
}

type recoverySurfaceAgents struct{ agent ports.Agent }

func (r recoverySurfaceAgents) Agent(domain.AgentHarness) (ports.Agent, bool) {
	return r.agent, true
}

func TestReconcileLive_UsesAuthoritativeCurrentSurfaceInsteadOfInventingIdle(t *testing.T) {
	store := newFakeStore()
	store.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	exactAlive := true
	runtime := &recoverySurfaceRuntime{
		fakeRuntime: &fakeRuntime{
			aliveByHandle:                map[string]bool{"tmux-v1:qualified": true},
			exactSupervisedAliveOverride: &exactAlive,
		},
		styledOutput: "provider-owned active frame",
	}
	observedAt := time.Date(2026, time.September, 2, 1, 2, 3, 0, time.UTC)
	manager := New(Deps{
		Runtime: runtime,
		Agents: recoverySurfaceAgents{agent: recoverySurfaceAgent{
			work: ports.TerminalSurfaceWorkActive,
		}},
		Workspace: &fakeWorkspace{}, Store: store,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: store},
		Clock:    func() time.Time { return observedAt },
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	record := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode, Mode: domain.SessionModeTUI,
		Activity:  domain.Activity{State: domain.ActivityExited, LastActivityAt: observedAt.Add(-time.Hour)},
		UpdatedAt: observedAt.Add(-time.Hour),
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", RuntimeHandleID: "tmux-v1:qualified",
			RuntimeLaunchID: "launch-current", AgentSessionID: "agent-s1",
		},
	}
	store.sessions[record.ID] = record
	store.previousActivities[record.ID] = domain.Activity{
		State: domain.ActivityIdle, LastActivityAt: observedAt.Add(-2 * time.Hour),
	}

	if err := manager.reconcileLive(context.Background(), record); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	got := store.sessions[record.ID]
	want := domain.Activity{State: domain.ActivityActive, LastActivityAt: observedAt}
	if got.Activity != want {
		t.Fatalf("recovered activity = %+v, want authoritative current surface %+v", got.Activity, want)
	}
	if len(runtime.exactRefs) != 2 {
		t.Fatalf("exact workload probes = %d, want proof before and after activity observation", len(runtime.exactRefs))
	}
}

func TestReconcileLive_WorkloadExitDuringActivityRecoveryDoesNotResurrectSession(t *testing.T) {
	store := newFakeStore()
	store.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	runtime := &fakeRuntime{
		aliveByHandle:      map[string]bool{"tmux-v1:qualified": true},
		supervisedSequence: []bool{true, false},
	}
	manager := New(Deps{
		Runtime: runtime, Agents: fakeAgents{}, Workspace: &fakeWorkspace{}, Store: store,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: store},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	record := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode, Mode: domain.SessionModeTUI,
		Activity: domain.Activity{State: domain.ActivityExited},
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", RuntimeHandleID: "tmux-v1:qualified",
			RuntimeLaunchID: "launch-current",
		},
	}
	store.sessions[record.ID] = record
	store.previousActivities[record.ID] = domain.Activity{
		State: domain.ActivityActive, LastActivityAt: time.Now().Add(-time.Minute),
	}

	if err := manager.reconcileLive(context.Background(), record); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if got := store.sessions[record.ID].Activity; got != record.Activity {
		t.Fatalf("workload that exited during recovery was resurrected: got %+v want %+v", got, record.Activity)
	}
}

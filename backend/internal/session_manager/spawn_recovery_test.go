package sessionmanager

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// A spawn is a chain of side effects, and a crash can land between any two of
// them. These tests pin the durable trace each timeout/crash point must leave,
// and the single safe action recovery takes from it.

func TestSpawn_CheckpointsWorkspaceBeforeAnythingSlow(t *testing.T) {
	m, st, _, _ := newManager()
	var observed domain.SessionRecord
	var seen bool
	// prepareWorkspace runs after provisioning and attachments; hook the agent's
	// hook installation, which is the first thing the launch path does with the
	// worktree, and read the durable row from there.
	m.agents = singleAgent{agent: &hookObservingAgent{
		onHooks: func() {
			rec, ok, _ := st.GetSession(context.Background(), "mer-1")
			observed, seen = rec, ok
		},
	}}

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Prompt: "do the thing"}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if !seen {
		t.Fatal("session row was not readable while the launch was still being prepared")
	}
	if got := domain.NormalizeSpawnPhase(observed.SpawnPhase); got != domain.SpawnPhaseWorkspaceReady {
		t.Fatalf("spawn phase during launch preparation = %q, want %q", got, domain.SpawnPhaseWorkspaceReady)
	}
	if observed.Metadata.WorkspacePath == "" {
		t.Fatal("workspace path was not checkpointed before the launch")
	}
	if observed.Metadata.Branch == "" {
		t.Fatal("branch was not checkpointed before the launch")
	}
	if observed.Metadata.Prompt != "do the thing" {
		t.Fatalf("checkpointed prompt = %q, want the original spawn prompt", observed.Metadata.Prompt)
	}
	// A single-repo spawn must be discoverable through its worktree row from the
	// same instant, or a crash here would orphan the worktree.
	if rows := st.worktrees["mer-1"]; len(rows) != 1 || rows[0].State != "active" {
		t.Fatalf("session worktree rows at checkpoint = %+v, want one active row", rows)
	}
	final, _, _ := st.GetSession(ctx, "mer-1")
	if got := domain.NormalizeSpawnPhase(final.SpawnPhase); got != domain.SpawnPhaseControllerReady {
		t.Fatalf("spawn phase after a successful spawn = %q, want %q", got, domain.SpawnPhaseControllerReady)
	}
}

type hookObservingAgent struct {
	fakeAgent
	onHooks func()
}

func (a *hookObservingAgent) GetAgentHooks(context.Context, ports.WorkspaceHookConfig) error {
	if a.onHooks != nil {
		a.onHooks()
	}
	return nil
}

func TestSpawn_CheckpointFailureRollsBackWithoutLeavingAWorktree(t *testing.T) {
	m, st, rt, ws := newManager()
	st.checkpointSpawnErr = errors.New("disk full")

	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Prompt: "task"})
	if err == nil || !errors.Is(err, ErrWorkspaceCreate) {
		t.Fatalf("Spawn err = %v, want ErrWorkspaceCreate", err)
	}
	if ws.destroyed != 1 {
		t.Fatalf("workspace destroys = %d, want the un-checkpointed worktree removed", ws.destroyed)
	}
	if rt.created != 0 {
		t.Fatalf("runtime creates = %d, want none: no controller may start without a checkpoint", rt.created)
	}
	if rec, present := st.sessions["mer-1"]; present {
		t.Fatalf("seed row survived a pre-checkpoint failure: %+v", rec)
	}
}

// A cancelled request is frequently the reason a spawn failed. Cleanup must not
// inherit that cancellation, or the user is left owning a worktree and a
// half-written row precisely when they asked to stop.
func TestSpawn_RollbackRunsAfterRequestCancellation(t *testing.T) {
	m, st, _, ws := newManager()
	m.runtime = &fakeRuntime{createErr: errors.New("boom")}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	if _, _, _, err := m.Spawn(cancelled, ports.SpawnConfig{ProjectID: "mer"}); err == nil {
		t.Fatal("Spawn on a cancelled context must fail")
	}
	if ws.destroyed != 1 {
		t.Fatalf("workspace destroys = %d, want 1 despite the cancelled request", ws.destroyed)
	}
	if ws.destroyCtxErr != nil {
		t.Fatalf("rollback inherited the caller's cancellation: %v", ws.destroyCtxErr)
	}
	if rec, present := st.sessions["mer-1"]; present {
		t.Fatalf("cancelled spawn left a row behind: %+v", rec)
	}
}

// A worktree the agent already dirtied belongs to the user, not to the failed
// spawn. Rollback keeps it, keeps its record, and parks the session terminated.
func TestSpawn_DirtyWorkspaceIsPreservedWithItsWorktreeRecord(t *testing.T) {
	m, st, _, ws := newManager()
	ws.destroyErr = errors.New("worktree contains modified or untracked files")
	m.runtime = &fakeRuntime{createErr: errors.New("boom")}

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Prompt: "task"}); err == nil {
		t.Fatal("expected the spawn to fail")
	}
	if slices.Contains(ws.calls, "ForceDestroy:mer-1") {
		t.Fatalf("rollback force-removed a dirty worktree; calls = %v", ws.calls)
	}
	rec, ok := st.sessions["mer-1"]
	if !ok {
		t.Fatal("a session whose worktree survives must not be deleted")
	}
	if !rec.IsTerminated {
		t.Fatalf("preserved-workspace rollback must park the session terminated, got %+v", rec)
	}
	if rec.Metadata.WorkspacePath == "" {
		t.Fatal("the preserved workspace path must stay on the record so it can be found again")
	}
	if rows := st.worktrees["mer-1"]; len(rows) != 1 {
		t.Fatalf("worktree rows = %+v, want the record kept for a worktree still on disk", rows)
	}
}

func TestReconcileLive_DropsInterruptedSeedThatOwnsNothing(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhasePreparing,
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if _, present := st.sessions["s1"]; present {
		t.Fatal("a seed row that never owned a workspace must not survive as a phantom session")
	}
	if ws.destroyed != 0 {
		t.Fatalf("workspace destroys = %d, want 0: there was never a workspace", ws.destroyed)
	}
	if rt.created != 0 {
		t.Fatalf("runtime creates = %d, want 0", rt.created)
	}
}

func TestReconcileLive_FinishesWorkspaceReadySpawnFreshWithItsPrompt(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", Prompt: "ship the feature",
			// No native or provider id: nothing ever established a conversation.
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime creates = %d, want 1", rt.created)
	}
	if slices.Contains(rt.lastCfg.Argv, "resume") {
		t.Fatalf("interrupted spawn resumed natively; argv = %v", rt.lastCfg.Argv)
	}
	if len(ws.restoreConfigs) != 1 || ws.restoreConfigs[0].Path != "/wt/s1" {
		t.Fatalf("Restore configs = %+v, want the checkpointed worktree reopened", ws.restoreConfigs)
	}
	if slices.Contains(ws.calls, "ForceDestroy:s1") {
		t.Fatalf("recovery destroyed the checkpointed worktree; calls = %v", ws.calls)
	}
	got := st.sessions["s1"]
	if domain.NormalizeSpawnPhase(got.SpawnPhase) != domain.SpawnPhaseControllerReady {
		t.Fatalf("recovered spawn phase = %q, want controller_ready", got.SpawnPhase)
	}
	if got.Metadata.RuntimeHandleID == "" {
		t.Fatal("controller_ready was published without a controller identity")
	}
}

func TestReconcileLive_KeepsControllerReadySessionOnNativeResume(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseControllerReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1",
			RuntimeHandleID: "dead", AgentSessionID: "agent-s1",
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if !slices.Contains(rt.lastCfg.Argv, "resume") {
		t.Fatalf("a fully spawned session must resume natively; argv = %v", rt.lastCfg.Argv)
	}
}

func TestReconcileLive_FailedSpawnRecoveryPreservesWorkspaceForRetry(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{createErr: errors.New("tmux unavailable")}
	ws := &fakeWorkspace{}
	lcm := &fakeLCM{store: st}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: lcm,
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", Prompt: "ship the feature",
		},
	}
	st.sessions[rec.ID] = rec

	err := m.reconcileLive(context.Background(), rec)
	if err == nil || !strings.Contains(err.Error(), "tmux unavailable") {
		t.Fatalf("reconcileLive err = %v, want the launch failure reported", err)
	}
	got := st.sessions["s1"]
	if got.IsTerminated {
		t.Fatal("a failed recovery must not terminate the session")
	}
	if got.Activity.State != domain.ActivityExited {
		t.Fatalf("activity = %q, want exited so the UI can offer a retry", got.Activity.State)
	}
	if domain.NormalizeSpawnPhase(got.SpawnPhase) != domain.SpawnPhaseWorkspaceReady {
		t.Fatalf("spawn phase = %q, want workspace_ready so retry stays a fresh start", got.SpawnPhase)
	}
	if got.Metadata.WorkspacePath != "/wt/s1" {
		t.Fatalf("workspace path = %q, want the preserved worktree", got.Metadata.WorkspacePath)
	}
	if ws.destroyed != 0 || slices.Contains(ws.calls, "ForceDestroy:s1") {
		t.Fatalf("failed recovery destroyed the user's workspace; destroys=%d calls=%v", ws.destroyed, ws.calls)
	}
}

// Retry after a failed recovery must re-run the interrupted spawn, not attempt
// a native resume: there is no runtime handle and no provider conversation.
func TestResumeAgent_InterruptedSpawnRetriesFresh(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["s1"] = domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Activity:   domain.Activity{State: domain.ActivityExited},
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", Prompt: "ship the feature",
			// No RuntimeHandleID: the ordinary resume path would refuse this row
			// outright with ErrIncompleteHandle.
		},
	}

	if _, err := m.ResumeAgentWithMode(context.Background(), "s1"); err != nil {
		t.Fatalf("ResumeAgentWithMode: %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime creates = %d, want 1", rt.created)
	}
	if slices.Contains(rt.lastCfg.Argv, "resume") {
		t.Fatalf("retry resumed natively; argv = %v", rt.lastCfg.Argv)
	}
	if got := st.sessions["s1"]; domain.NormalizeSpawnPhase(got.SpawnPhase) != domain.SpawnPhaseControllerReady {
		t.Fatalf("phase after a successful retry = %q, want controller_ready", got.SpawnPhase)
	}
}

// The fresh-start rule is asymmetric on purpose: an empty provider conversation
// id means "never started" only at workspace_ready. Anywhere else it means the
// id was lost, and starting fresh would abandon a live conversation.
func TestRecoverWorkspaceReadySpawn_RefusesAnyOtherPhase(t *testing.T) {
	m, st, _, _ := newManager()
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		Mode:       domain.SessionModeChat,
		SpawnPhase: domain.SpawnPhaseControllerReady,
		Metadata:   domain.SessionMetadata{Branch: "ao/s1/root", WorkspacePath: "/wt/s1"},
	}
	st.sessions[rec.ID] = rec

	_, err := m.recoverWorkspaceReadySpawn(context.Background(), "retry agent", rec)
	if !errors.Is(err, ErrIncompleteHandle) {
		t.Fatalf("err = %v, want ErrIncompleteHandle for a fresh launch outside workspace_ready", err)
	}
}

// A Chat spawn interrupted before its controller committed has no provider
// conversation and never delivered its prompt. Recovery must open a fresh
// conversation and deliver that prompt exactly once — no resume, no duplicate.
func TestReconcileLive_ChatInterruptedSpawnStartsFreshAndDeliversPromptOnce(t *testing.T) {
	launcher := &recordingLauncher{}
	m, st, rt := newChatManager(launcher)
	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: chatTestProject, Kind: domain.KindWorker,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/mer-1/root", WorkspacePath: "/ws/mer-1", Prompt: "ship the feature",
			// No ProviderConversationID: no conversation was ever opened.
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if len(launcher.started) != 1 {
		t.Fatalf("chat starts = %d, want exactly one", len(launcher.started))
	}
	if launcher.started[0].ProviderConversationID != "" {
		t.Fatalf("recovery resumed a conversation that never existed: %q", launcher.started[0].ProviderConversationID)
	}
	if len(launcher.turns) != 1 || launcher.turns[0] != "ship the feature" {
		t.Fatalf("delivered turns = %v, want the checkpointed prompt exactly once", launcher.turns)
	}
	if rt.created != 0 {
		t.Fatalf("terminal runtime Create calls = %d, want 0 for Chat", rt.created)
	}
	got := st.sessions[rec.ID]
	if domain.NormalizeSpawnPhase(got.SpawnPhase) != domain.SpawnPhaseControllerReady {
		t.Fatalf("spawn phase = %q, want controller_ready", got.SpawnPhase)
	}
	if got.Metadata.ControllerGeneration == "" {
		t.Fatal("controller_ready published without a Chat controller generation")
	}
}

// A second reconcile pass over an already recovered session must not re-deliver
// the prompt: controller_ready takes the ordinary native-resume path.
func TestReconcileLive_ChatControllerReadyResumesWithoutRedeliveringThePrompt(t *testing.T) {
	launcher := &recordingLauncher{}
	m, st, _ := newChatManager(launcher)
	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: chatTestProject, Kind: domain.KindWorker,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		SpawnPhase: domain.SpawnPhaseControllerReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/mer-1/root", WorkspacePath: "/ws/mer-1", Prompt: "ship the feature",
			ProviderConversationID: "thread-existing",
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if len(launcher.started) != 1 || launcher.started[0].ProviderConversationID != "thread-existing" {
		t.Fatalf("chat starts = %+v, want a native resume of the existing thread", launcher.started)
	}
	if len(launcher.turns) != 0 {
		t.Fatalf("delivered turns = %v, want none: the prompt was already delivered", launcher.turns)
	}
}

// An interface transition in flight clears the runtime handle, launch id, and
// controller generation together on a live row, which makes it look exactly
// like an abandoned seed. It is not one: it names a conversation. Fresh-starting
// it would abandon that conversation and deliver the original prompt twice.
func TestReconcileLive_MidTransitionTUIRowResumesItsNativeSession(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{aliveByHandle: map[string]bool{}}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		// The phase column says "abandoned seed"; the durable facts disagree.
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", Prompt: "ship the feature",
			AgentSessionID: "agent-s1",
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime creates = %d, want 1", rt.created)
	}
	if !slices.Contains(rt.lastCfg.Argv, "resume") {
		t.Fatalf("a row naming a native session must resume it, not start fresh; argv = %v", rt.lastCfg.Argv)
	}
}

// The Chat half of the same rule, where re-delivering the prompt would be
// visible to the user as a duplicated turn.
func TestReconcileLive_MidTransitionChatRowResumesWithoutRedeliveringThePrompt(t *testing.T) {
	launcher := &recordingLauncher{}
	m, st, _ := newChatManager(launcher)
	rec := domain.SessionRecord{
		ID: "mer-1", ProjectID: chatTestProject, Kind: domain.KindWorker,
		Harness: domain.HarnessCodex, Mode: domain.SessionModeChat,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/mer-1/root", WorkspacePath: "/ws/mer-1", Prompt: "ship the feature",
			ProviderConversationID: "thread-1",
		},
	}
	st.sessions[rec.ID] = rec

	if err := m.reconcileLive(context.Background(), rec); err != nil {
		t.Fatalf("reconcileLive: %v", err)
	}
	if len(launcher.started) != 1 || launcher.started[0].ProviderConversationID != "thread-1" {
		t.Fatalf("chat starts = %+v, want the existing thread resumed", launcher.started)
	}
	if len(launcher.turns) != 0 {
		t.Fatalf("delivered turns = %v, want none: this prompt was already delivered", launcher.turns)
	}
}

// The fresh-launch primitive refuses the same case directly, so no caller —
// reconcile or Retry — can reach a fresh start over an existing conversation.
func TestRecoverWorkspaceReadySpawn_RefusesToRestartAnExistingConversation(t *testing.T) {
	m, st, _, _ := newManager()
	rec := domain.SessionRecord{
		ID: "s1", ProjectID: "mer", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1",
			ProviderConversationID: "thread-1",
		},
	}
	st.sessions[rec.ID] = rec

	_, err := m.recoverWorkspaceReadySpawn(context.Background(), "retry agent", rec)
	if !errors.Is(err, ErrIncompleteHandle) {
		t.Fatalf("err = %v, want ErrIncompleteHandle rather than a fresh launch", err)
	}
}

// Between the workspace checkpoint and MarkSpawned a healthy TUI spawn is
// workspace_ready with idle activity. Retry must not reopen the workspace and
// launch a second provider on top of the spawn that is still running: the
// exited precondition, not the phase, is what proves the first attempt is over.
func TestResumeAgent_RefusesToRetryASpawnStillInFlight(t *testing.T) {
	st := newFakeStore()
	st.projects["p1"] = domain.ProjectRecord{ID: "p1", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	m := New(Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	st.sessions["s1"] = domain.SessionRecord{
		ID: "s1", ProjectID: "p1", Harness: domain.HarnessClaudeCode,
		SpawnPhase: domain.SpawnPhaseWorkspaceReady,
		// Exactly what an in-flight spawn looks like just after its checkpoint.
		Activity: domain.Activity{State: domain.ActivityIdle},
		Metadata: domain.SessionMetadata{
			Branch: "ao/s1/root", WorkspacePath: "/wt/s1", Prompt: "ship the feature",
		},
	}

	_, err := m.ResumeAgentWithMode(context.Background(), "s1")
	if !errors.Is(err, ErrAgentNotExited) {
		t.Fatalf("err = %v, want ErrAgentNotExited", err)
	}
	if rt.created != 0 {
		t.Fatalf("runtime creates = %d, want 0: a running spawn must not be relaunched", rt.created)
	}
	if len(ws.restoreConfigs) != 0 {
		t.Fatalf("Restore configs = %+v, want none for a spawn still in flight", ws.restoreConfigs)
	}
}

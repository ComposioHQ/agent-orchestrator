package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// resolverAgent is a fakeAgent that also satisfies ports.AgentBinaryResolver, so
// the spawn preflight can ask it whether its CLI is installed.
type resolverAgent struct {
	fakeAgent
	path     string
	resolve  error
	resolved int
}

func (a *resolverAgent) ResolveBinary(context.Context) (string, error) {
	a.resolved++
	if a.resolve != nil {
		return "", a.resolve
	}
	return a.path, nil
}

func newPreflightManager(t *testing.T, agent ports.Agent) (*Manager, *fakeStore, *fakeWorkspace, *fakeRuntime) {
	t.Helper()
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	ws := &fakeWorkspace{}
	rt := &fakeRuntime{}
	m := New(Deps{
		Runtime: rt, Agents: singleAgent{agent: agent}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		LookPath: func(string) (string, error) { return "/bin/true", nil },
	})
	return m, st, ws, rt
}

// A harness whose CLI is missing must be rejected before the spawn builds
// anything: the old argv[0] guard ran after the seed row, the worktree, and
// workspace provisioning, so every uninstalled-agent spawn paid for work it then
// had to roll back.
func TestSpawn_PreflightRejectsMissingAgentBinaryBeforeDurableState(t *testing.T) {
	agent := &resolverAgent{resolve: fmt.Errorf("claude: %w", ports.ErrAgentBinaryNotFound)}
	m, st, ws, rt := newPreflightManager(t, agent)

	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
	}
	if !strings.Contains(err.Error(), "install the claude-code CLI") {
		t.Fatalf("err = %v, want an actionable install hint naming the harness", err)
	}
	if agent.resolved == 0 {
		t.Fatal("preflight must ask the adapter to resolve its binary")
	}
	if len(st.sessions) != 0 {
		t.Fatalf("no session row should be created when the agent CLI is missing, got %d", len(st.sessions))
	}
	if ws.lastCfg.SessionID != "" || ws.destroyed != 0 {
		t.Fatal("workspace must not be created when the agent CLI is missing")
	}
	if rt.created != 0 {
		t.Fatal("runtime must not be created when the agent CLI is missing")
	}
}

// An inconclusive probe is not evidence the CLI is absent. Refusing a spawn that
// would have worked is worse than the late argv[0] failure, so the spawn runs.
func TestSpawn_PreflightAllowsInconclusiveBinaryProbe(t *testing.T) {
	agent := &resolverAgent{resolve: errors.New("permission denied reading candidate dir")}
	m, st, _, _ := newPreflightManager(t, agent)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(st.sessions) != 1 {
		t.Fatalf("sessions = %d, want the spawn to proceed on an inconclusive probe", len(st.sessions))
	}
}

func TestSpawn_PreflightAcceptsInstalledAgentBinary(t *testing.T) {
	agent := &resolverAgent{path: "/usr/local/bin/claude"}
	m, st, _, _ := newPreflightManager(t, agent)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if len(st.sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(st.sessions))
	}
}

// Chat sessions reach their provider through PreflightChat, which probes the
// driver itself, so the terminal-oriented preflight must stay out of their way.
func TestPreflightSpawnEnvironment_SkipsChatMode(t *testing.T) {
	agent := &resolverAgent{resolve: fmt.Errorf("claude: %w", ports.ErrAgentBinaryNotFound)}
	m, _, _, _ := newPreflightManager(t, agent)

	if err := m.preflightSpawnEnvironment(ctx, domain.HarnessClaudeCode, domain.SessionModeChat); err != nil {
		t.Fatalf("chat preflight = %v, want nil", err)
	}
	if agent.resolved != 0 {
		t.Fatal("chat mode must not run the terminal agent-binary preflight")
	}
}

// Adapters that cannot report their binary without a launch command are left to
// the pre-launch argv[0] guard rather than being blocked here.
func TestPreflightAgentBinary_SkipsAdapterWithoutResolver(t *testing.T) {
	m, _, _, _ := newPreflightManager(t, fakeAgent{})

	if err := m.preflightAgentBinary(ctx, domain.HarnessClaudeCode); err != nil {
		t.Fatalf("preflightAgentBinary = %v, want nil", err)
	}
}

func TestTmuxInstallHintNamesACommand(t *testing.T) {
	if hint := tmuxInstallHint(); !strings.Contains(hint, "tmux") {
		t.Fatalf("tmuxInstallHint = %q, want it to name the tmux install command", hint)
	}
}

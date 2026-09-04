package sessionmanager

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// These cover Untrivial-ai/agent-orchestrator#4895, reported downstream as
// menard-software/setup-agent-orchestrator#418: AO created Claude children that
// stopped before their agent loop, and reported them as ordinary work. Process
// creation is not successful startup, and the only place that can be fixed is
// before the child exists.
//
// They are written at the same seam as TestSpawn_RejectsMissingAgentBinary,
// because that check already proves the shape a pre-spawn refusal must have:
// runtime.Create must not run, and the workspace must be torn down.

type recordingLaunchGate struct {
	decision ports.PreLaunchDecision
	err      error
	seen     []ports.PreLaunchRequest
}

func (g *recordingLaunchGate) PreLaunch(_ context.Context, req ports.PreLaunchRequest) (ports.PreLaunchDecision, error) {
	g.seen = append(g.seen, req)
	return g.decision, g.err
}

func gateSpawnDeps(t *testing.T, gate ports.LaunchGate) (*fakeRuntime, *fakeWorkspace, Deps) {
	t.Helper()
	st := newFakeStore()
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: testRoleAgents()}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{}
	return rt, ws, Deps{
		Runtime: rt, Agents: fakeAgents{}, Workspace: ws, Store: st,
		Messenger: &fakeMessenger{}, Lifecycle: &fakeLCM{store: st},
		DataDir: t.TempDir(), LaunchGate: gate,
		// The binary check runs before the gate; stub it so these tests exercise
		// the gate rather than PATH resolution.
		LookPath: func(name string) (string, error) { return "/usr/bin/" + name, nil },
	}
}

// A gate that refuses must stop the spawn before any child exists, exactly like
// the missing-binary check. Without this, AO produces a session card for a
// child that was never able to become ready -- the #418 symptom.
func TestSpawn_LaunchGateRefusalStopsBeforeChildCreation(t *testing.T) {
	gate := &recordingLaunchGate{decision: ports.PreLaunchDecision{
		Allow: false, Reason: "workspace trust not accepted", PromptKind: "workspace_trust",
	}}
	rt, ws, deps := gateSpawnDeps(t, gate)
	m := New(deps)

	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})

	if !errors.Is(err, ports.ErrLaunchNotReady) {
		t.Fatalf("err = %v, want ports.ErrLaunchNotReady", err)
	}
	if !errors.Is(err, ErrSpawnLaunchGate) {
		t.Fatalf("err = %v, want it to name the launch-readiness spawn stage", err)
	}
	for _, want := range []string{"workspace trust not accepted", "workspace_trust"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("err = %v, want it to carry %q so the cause is actionable", err, want)
		}
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must NOT run when the launch gate refuses")
	}
	if ws.destroyed != 1 {
		t.Fatal("workspace must be torn down when the pre-launch gate refuses")
	}
	if len(gate.seen) != 1 {
		t.Fatalf("gate consulted %d times, want exactly once", len(gate.seen))
	}
}

// The zero decision refuses. A gate that returns nothing by mistake must stop
// the launch rather than wave it through.
func TestSpawn_LaunchGateZeroDecisionRefuses(t *testing.T) {
	rt, _, deps := gateSpawnDeps(t, &recordingLaunchGate{})
	m := New(deps)

	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})

	if !errors.Is(err, ports.ErrLaunchNotReady) {
		t.Fatalf("err = %v, want the zero decision to refuse", err)
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must NOT run for a zero decision")
	}
}

// A gate error is a refusal, not a warning: an unreachable or broken gate must
// not silently degrade into an ungated launch.
func TestSpawn_LaunchGateErrorRefusesRatherThanDegrades(t *testing.T) {
	gate := &recordingLaunchGate{err: errors.New("gate unavailable")}
	rt, _, deps := gateSpawnDeps(t, gate)
	m := New(deps)

	_, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker})

	if !errors.Is(err, ports.ErrLaunchNotReady) {
		t.Fatalf("err = %v, want a gate error to fail closed", err)
	}
	if !strings.Contains(err.Error(), "gate unavailable") {
		t.Fatalf("err = %v, want the underlying gate error preserved", err)
	}
	if rt.created != 0 {
		t.Fatal("runtime.Create must NOT run when the gate itself fails")
	}
}

// A permitted launch reaches the child, and the gate's environment contribution
// reaches the exact child AO is about to create. This is the half of #4895 a
// post-spawn helper cannot do.
func TestSpawn_LaunchGateContributesChildEnvironment(t *testing.T) {
	gate := &recordingLaunchGate{decision: ports.PreLaunchDecision{
		Allow: true,
		Env:   map[string]string{"CLAUDE_CONFIG_DIR": "/isolated/session/config"},
	}}
	rt, _, deps := gateSpawnDeps(t, gate)
	m := New(deps)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create ran %d times, want 1", rt.created)
	}
	if got := rt.lastCfg.Env["CLAUDE_CONFIG_DIR"]; got != "/isolated/session/config" {
		t.Fatalf("child CLAUDE_CONFIG_DIR = %q, want the gate's value", got)
	}
}

// The gate contributes; it does not take over. An AO-owned variable must win,
// so a gate cannot redirect the session's own data directory or run file.
func TestSpawn_LaunchGateCannotOverrideAOOwnedEnvironment(t *testing.T) {
	gate := &recordingLaunchGate{decision: ports.PreLaunchDecision{
		Allow: true,
		Env:   map[string]string{"AO_SESSION_ID": "someone-else", "GATE_ONLY": "kept"},
	}}
	rt, _, deps := gateSpawnDeps(t, gate)
	m := New(deps)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if got := rt.lastCfg.Env["AO_SESSION_ID"]; got == "someone-else" {
		t.Fatal("a gate must not overwrite an AO-owned environment variable")
	}
	if got := rt.lastCfg.Env["GATE_ONLY"]; got != "kept" {
		t.Fatalf("GATE_ONLY = %q, want the gate's own key to survive", got)
	}
}

// The request carries daemon-owned values only, and the argv the child will
// actually run, so a gate can confirm a resolved permission mode reaches it.
func TestSpawn_LaunchGateSeesResolvedDaemonOwnedValues(t *testing.T) {
	gate := &recordingLaunchGate{decision: ports.PreLaunchDecision{Allow: true}}
	_, _, deps := gateSpawnDeps(t, gate)
	m := New(deps)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	if len(gate.seen) != 1 {
		t.Fatalf("gate consulted %d times, want exactly once", len(gate.seen))
	}
	req := gate.seen[0]
	if req.SessionID == "" {
		t.Fatal("request must carry the AO session id")
	}
	if req.WorkspacePath == "" {
		t.Fatal("request must carry the AO-created workspace path")
	}
	if req.Kind != domain.KindWorker {
		t.Fatalf("request kind = %v, want the spawn's kind", req.Kind)
	}
	if len(req.Argv) == 0 {
		t.Fatal("request must carry the exact child argv")
	}
}

// Nil gate is the default and must leave spawn byte-identical.
func TestSpawn_WithoutLaunchGateIsUnchanged(t *testing.T) {
	rt, _, deps := gateSpawnDeps(t, nil)
	m := New(deps)

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatalf("spawn without a gate: %v", err)
	}
	if rt.created != 1 {
		t.Fatalf("runtime.Create ran %d times, want 1", rt.created)
	}
}


package sessionmanager

import (
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestMemoryCeilingArgv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("memory ceiling is a unix-only guardrail")
	}
	argv := []string{"claude", "--flag"}
	wrapped := memoryCeilingArgv(argv, 8192)
	if wrapped[0] != "/bin/sh" || wrapped[1] != "-c" {
		t.Fatalf("wrapped argv = %v, want a /bin/sh -c prefix", wrapped)
	}
	if !strings.Contains(wrapped[2], "ulimit -v 8388608") {
		t.Fatalf("wrapper script %q missing the KB ulimit", wrapped[2])
	}
	if got := wrapped[len(wrapped)-2:]; got[0] != "claude" || got[1] != "--flag" {
		t.Fatalf("wrapped argv tail = %v, want original argv preserved", got)
	}
	// Unconfigured means untouched.
	if got := memoryCeilingArgv(argv, 0); &got[0] != &argv[0] {
		t.Fatalf("zero ceiling must return argv unchanged, got %v", got)
	}
}

func TestSpawnAppliesConfiguredMemoryCeiling(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("memory ceiling is a unix-only guardrail")
	}
	m, st, rt, _ := newManager()
	cfg := testRoleAgents()
	cfg.AgentConfig = domain.AgentConfig{MaxMemoryMB: 4096}
	st.projects["mer"] = domain.ProjectRecord{ID: "mer", Config: cfg}

	if _, _, _, err := m.Spawn(ctx, ports.SpawnConfig{ProjectID: "mer", Kind: domain.KindWorker}); err != nil {
		t.Fatal(err)
	}
	argv := rt.lastCfg.Argv
	if len(argv) < 4 || argv[0] != "/bin/sh" || !strings.Contains(argv[2], "ulimit -v 4194304") {
		t.Fatalf("runtime argv = %v, want the ulimit wrapper applied", argv)
	}
}

package agy

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestExitDetectionModeUsesSupervisor(t *testing.T) {
	plugin := New()
	if got := plugin.ExitDetectionMode(); got != ports.AgentExitDetectionSupervisor {
		t.Fatalf("ExitDetectionMode() = %q, want %q", got, ports.AgentExitDetectionSupervisor)
	}
}

package sessionmanager

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/claudeops"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (m *Manager) acquireProviderControllerAdmission(ctx context.Context, harness domain.AgentHarness) (func(), error) {
	switch harness {
	case domain.HarnessCodex:
		if m.codexOperationGate != nil {
			return m.codexOperationGate.AcquireShared(ctx)
		}
	case domain.HarnessClaudeCode:
		if m.claudeCodeOperationGate != nil {
			return m.claudeCodeOperationGate.AcquireShared(ctx)
		}
	}
	return func() {}, nil
}

func defaultClaudeCodeOperationGate(gate ports.ClaudeCodeOperationGate) ports.ClaudeCodeOperationGate {
	if gate != nil {
		return gate
	}
	return claudeops.NewGate()
}

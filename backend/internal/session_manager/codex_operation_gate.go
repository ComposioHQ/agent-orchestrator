package sessionmanager

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/codexops"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type codexExclusiveOperationContextKey struct{}

func codexExclusiveOperationContext(ctx context.Context) context.Context {
	return context.WithValue(ctx, codexExclusiveOperationContextKey{}, true)
}

func (m *Manager) acquireCodexControllerAdmission(ctx context.Context, harness domain.AgentHarness) (func(), error) {
	if harness != domain.HarnessCodex || m.codexOperationGate == nil || ctx.Value(codexExclusiveOperationContextKey{}) == true {
		return func() {}, nil
	}
	return m.codexOperationGate.AcquireShared(ctx)
}

func defaultCodexOperationGate(gate ports.CodexOperationGate) ports.CodexOperationGate {
	if gate != nil {
		return gate
	}
	return codexops.NewGate()
}

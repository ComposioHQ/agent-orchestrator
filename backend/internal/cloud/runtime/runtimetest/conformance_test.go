package runtimetest

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

func TestMemoryStoreConformance(t *testing.T) {
	RunStoreConformance(t, func() runtime.Store { return NewMemoryStore() })
}

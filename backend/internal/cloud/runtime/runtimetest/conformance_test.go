package runtimetest_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime/runtimetest"
)

// The in-memory store is the reference implementation, so it must pass the
// same suite every adapter is held to.
func TestMemoryStoreConformance(t *testing.T) {
	runtimetest.RunStoreConformance(t, func(*testing.T) runtime.Store {
		return runtimetest.NewMemoryStore()
	})
}

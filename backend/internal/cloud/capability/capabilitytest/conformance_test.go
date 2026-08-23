package capabilitytest_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability/capabilitytest"
)

// The in-memory store is the reference implementation, so it must pass the
// same suite every adapter is held to.
func TestMemoryStoreConformance(t *testing.T) {
	capabilitytest.RunStoreConformance(t, func(*testing.T) capability.Store {
		return capability.NewMemoryStore()
	})
}

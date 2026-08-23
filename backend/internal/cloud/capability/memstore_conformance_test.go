package capability_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability/storetest"
)

func TestMemoryStoreConformance(t *testing.T) {
	storetest.RunCapabilityConformance(t, func() capability.Store { return capability.NewMemoryStore() })
}

package deveco

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DeriveActivityState reuses OpenCode's normalized event vocabulary. DevEco's
// plugin emits the same AO event names from its compatible lifecycle API.
func DeriveActivityState(event string, payload []byte) (domain.ActivityState, bool) {
	return opencode.DeriveActivityState(event, payload)
}

package agy

import (
	"encoding/json"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// DeriveActivityState maps the current Antigravity workspace-hook events onto
// AO activity. PreInvocation proves an execution is running. PostToolUse keeps
// the session active after a tool finishes. Stop is the provider-owned execution
// boundary; fullyIdle=false means background/asynchronous work is still alive,
// so AO must not advertise the worker as idle yet.
func DeriveActivityState(event string, payload []byte) (domain.ActivityState, bool) {
	switch event {
	case "pre-invocation", "post-tool-use":
		return domain.ActivityActive, true
	case "stop":
		if fullyIdle, known := agyStopFullyIdle(payload); known && !fullyIdle {
			return domain.ActivityActive, true
		}
		return domain.ActivityIdle, true
	default:
		return "", false
	}
}

func agyStopFullyIdle(payload []byte) (bool, bool) {
	var p struct {
		FullyIdle      *bool `json:"fullyIdle"`
		FullyIdleSnake *bool `json:"fully_idle"`
	}
	if err := json.Unmarshal(payload, &p); err != nil {
		return false, false
	}
	if p.FullyIdle != nil {
		return *p.FullyIdle, true
	}
	if p.FullyIdleSnake != nil {
		return *p.FullyIdleSnake, true
	}
	return false, false
}

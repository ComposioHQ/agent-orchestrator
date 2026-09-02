//go:build windows

package conpty

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/processalive"
)

// pidAlive probes PID liveness on Windows.
func pidAlive(pid int) bool {
	return processalive.Alive(pid)
}

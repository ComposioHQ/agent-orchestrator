package deepseekharness

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus reports DeepSeek CLI's local auth posture without making a
// model call.
//
//   - binary missing on PATH and well-known locations → unknown, with
//     ports.ErrAgentBinaryNotFound so callers surface the install step.
//   - binary present → run `deepseek --version` with a 3 s timeout. A zero exit
//     means the CLI is runnable; we still cannot prove its /auth state,
//     so the probe returns unknown. The actual launch remains the
//     authoritative check.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	binary, err := p.deepseekBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// --version is the cheapest local probe: it confirms the launcher is
	// runnable without contacting the model provider.
	if _, err := aoprocess.CommandContext(probeCtx, binary, "--version").CombinedOutput(); err != nil {
		if probeCtx.Err() != nil {
			return ports.AgentAuthStatusUnknown, probeCtx.Err()
		}
		return ports.AgentAuthStatusUnknown, nil
	}
	if probeCtx.Err() != nil {
		return ports.AgentAuthStatusUnknown, probeCtx.Err()
	}
	return ports.AgentAuthStatusUnknown, nil
}

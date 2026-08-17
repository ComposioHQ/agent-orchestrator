package deepseekharness

import (
	"context"
	"os"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// deepseekAPIKeyEnvVar is the name of the env var DeepSeek Harness reads for
// an API key. A non-empty value is treated as a positive auth signal — it
// short-circuits the binary probe entirely.
//
//nolint:gosec // G101: this is the env var name, not a credential value.
const deepseekAPIKeyEnvVar = "DEEPSEEK_API_KEY"

// AuthStatus reports DeepSeek Harness's local auth posture without making a
// model call.
//
//   - DEEPSEEK_API_KEY non-empty → authorized.
//   - binary missing on PATH and well-known locations → unknown, with
//     ports.ErrAgentBinaryNotFound so callers surface the install step.
//   - binary present → run `dsh --version` with a 3 s timeout. A zero exit
//     means the CLI is runnable; we still cannot prove a key is configured,
//     so the probe returns unknown. The actual launch remains the
//     authoritative check.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}

	if strings.TrimSpace(os.Getenv(deepseekAPIKeyEnvVar)) != "" {
		return ports.AgentAuthStatusAuthorized, nil
	}

	binary, err := p.dshBinary(ctx)
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

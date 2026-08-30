package systeminstall

import (
	"context"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const defaultVerifyTimeout = 5 * time.Second

// VerifyResult is the non-authenticating evidence collected after an install.
type VerifyResult struct {
	ResolvedPath string
	Output       string
}

// Verifier resolves the executable through the same adapter sessions use and
// runs a bounded version probe against that exact path.
type Verifier struct {
	agents   ports.AgentResolver
	commands ports.CommandRunner
	timeout  time.Duration
}

func NewVerifier(agents ports.AgentResolver, commands ports.CommandRunner) *Verifier {
	return &Verifier{agents: agents, commands: commands, timeout: defaultVerifyTimeout}
}

func (v *Verifier) Verify(ctx context.Context, target Target) (VerifyResult, error) {
	if !IsAgentTarget(target) {
		return VerifyResult{}, fmt.Errorf("systeminstall: %s is not a harness", target)
	}
	if v.agents == nil || v.commands == nil {
		return VerifyResult{}, fmt.Errorf("systeminstall: harness verifier is not configured")
	}
	agent, ok := v.agents.Agent(domain.AgentHarness(target))
	if !ok {
		return VerifyResult{}, fmt.Errorf("systeminstall: no adapter registered for %s", target)
	}
	resolver, ok := agent.(ports.AgentBinaryResolver)
	if !ok {
		return VerifyResult{}, fmt.Errorf("systeminstall: adapter for %s cannot resolve its binary", target)
	}

	probeCtx, cancel := context.WithTimeout(ctx, v.timeout)
	defer cancel()
	path, err := resolver.ResolveBinary(probeCtx)
	if err != nil {
		return VerifyResult{}, fmt.Errorf("resolve installed %s binary: %w", target, err)
	}
	if path == "" {
		return VerifyResult{}, fmt.Errorf("resolve installed %s binary: empty path", target)
	}
	out := &capturedOutput{max: maxOutputBytes}
	if err := v.commands.Run(probeCtx, []string{path, "--version"}, out, out); err != nil {
		return VerifyResult{ResolvedPath: path, Output: out.String()}, fmt.Errorf("run %s version probe: %w", target, err)
	}
	return VerifyResult{ResolvedPath: path, Output: out.String()}, nil
}

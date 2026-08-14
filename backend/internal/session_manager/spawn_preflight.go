package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// agentBinaryPreflightTimeout bounds the pre-spawn binary probe. Resolving a
// binary is local PATH and filesystem work, so this matches the agent catalog's
// install-probe budget: generous for a slow disk, short enough that a wedged
// probe cannot stall a spawn.
const agentBinaryPreflightTimeout = 2 * time.Second

// preflightSpawnEnvironment proves the local machine can actually launch the
// requested harness BEFORE Spawn creates anything durable.
//
// Both failures it catches used to surface late: the missing agent binary was
// only detected once argv had been built, which is after the seed row, the
// worktree, workspace provisioning (which may run `pnpm install`), and the
// attachment writes. The spawn then had to be rolled back, and the user paid
// for all of that work to learn their CLI is not installed. Checked here, a
// machine that cannot run the harness costs one PATH lookup.
//
// A chat session runs no agent inside a terminal runtime and reaches its driver
// through PreflightChat, which probes the provider itself, so neither check is
// its concern.
func (m *Manager) preflightSpawnEnvironment(ctx context.Context, harness domain.AgentHarness, mode domain.SessionMode) error {
	if mode != domain.SessionModeTUI {
		return nil
	}
	if err := m.validateRuntimePrerequisites(); err != nil {
		return err
	}
	return m.preflightAgentBinary(ctx, harness)
}

// preflightAgentBinary reports that the harness's CLI is missing, using the
// adapter's own resolver so no workspace or launch command is needed.
//
// It is deliberately one-sided: only a definitive "not found" blocks the spawn.
// An adapter that cannot be asked, or a probe that fails for any other reason,
// is not evidence the CLI is absent, and refusing a spawn that would have
// worked is worse than the late failure this replaces. The pre-launch argv[0]
// guard in Spawn stays authoritative for those cases.
func (m *Manager) preflightAgentBinary(ctx context.Context, harness domain.AgentHarness) error {
	agent, ok := m.agents.Agent(harness)
	if !ok {
		// Spawn rejects an unknown harness before calling this.
		return nil
	}
	resolver, ok := agent.(ports.AgentBinaryResolver)
	if !ok {
		return nil
	}
	probeCtx, cancel := context.WithTimeout(ctx, agentBinaryPreflightTimeout)
	defer cancel()
	_, err := resolver.ResolveBinary(probeCtx)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ports.ErrAgentBinaryNotFound):
		return fmt.Errorf("%w: install the %s CLI and make sure its binary is on PATH", ports.ErrAgentBinaryNotFound, harness)
	default:
		m.logger.Warn("spawn: agent binary preflight inconclusive", "harness", harness, "error", err)
		return nil
	}
}

// tmuxInstallHint names the command that installs tmux on this platform so the
// spawn error tells the user what to run, not only what is missing.
func tmuxInstallHint() string {
	if runtime.GOOS == "darwin" {
		return "`brew install tmux`"
	}
	return "your package manager (for example `apt install tmux` or `dnf install tmux`)"
}

// Package deepseekharness implements AO's DeepSeek CLI agent adapter. The
// registry id stays "deepseek-harness" for compatibility with existing project
// settings and stored sessions, but the runtime launches the authenticated
// `deepseek` CLI.
//
// The adapter is deliberately minimal:
//   - launches `deepseek` in interactive mode, optionally seeding the first
//     prompt with `--prompt-interactive`;
//   - does not attempt native resume, so GetRestoreCommand is false;
//   - does not consult or install hooks, so the inherited no-op GetAgentHooks
//     is correct.
package deepseekharness

import (
	"context"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// adapterID is the registry id and the value users pass to
// `ao spawn --agent`. It matches domain.HarnessDeepSeek.
const adapterID = "deepseek-harness"

// deepseekBinarySpec locates the DeepSeek CLI: PATH first, then the
// install-script and Homebrew locations, the standard Node-managed fallback
// paths, and the npm shims under %APPDATA% on Windows.
var deepseekBinarySpec = binaryutil.BinarySpec{
	Label:         "deepseek-harness",
	Names:         []string{"deepseek"},
	WinNames:      []string{"deepseek.cmd", "deepseek.exe", "deepseek"},
	UnixPaths:     []string{"/usr/local/bin/deepseek", "/opt/homebrew/bin/deepseek"},
	UnixHomePaths: binaryutil.NodeManagedUnixHomePaths("deepseek"),
	NodeManaged:   true,
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "deepseek.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "deepseek.exe"}},
	},
}

// Plugin is the DeepSeek CLI agent adapter. It is safe for concurrent use;
// the binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register DeepSeek adapter.
func New() *Plugin {
	return &Plugin{}
}

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)
var _ ports.AgentBinaryResolver = (*Plugin)(nil)
var _ ports.AgentExitDetector = (*Plugin)(nil)

// Manifest returns the adapter's static self-description.
func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "DeepSeek CLI",
		Description: "Run DeepSeek CLI interactive sessions.",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports no agent-specific config keys. Model selection is owned
// by the DeepSeek CLI config, so there is nothing for AO to expose.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{}, nil
}

// GetLaunchCommand builds the argv to run an interactive DeepSeek CLI session:
//
//	deepseek [--prompt-interactive <prompt>]
//
// The runtime sets cwd to cfg.WorkspacePath, matching every other shipped
// adapter.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prompt := strings.TrimSpace(cfg.Prompt)

	binary, err := p.deepseekBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary}
	if prompt != "" {
		cmd = append(cmd, "--prompt-interactive", prompt)
	}
	return cmd, nil
}

// SessionInfo surfaces DeepSeek CLI metadata persisted by AO under the shared
// ports.MetadataKey* keys.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// ExitDetectionMode opts DeepSeek CLI into AO's process supervisor.
func (p *Plugin) ExitDetectionMode() ports.AgentExitDetectionMode {
	return ports.AgentExitDetectionSupervisor
}

// ResolveDeepSeekBinary returns the path to the `deepseek` binary on this machine,
// searching PATH then a handful of well-known install locations. It returns a
// wrapped ports.ErrAgentBinaryNotFound when `deepseek` is absent.
func ResolveDeepSeekBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, deepseekBinarySpec)
}

// deepseekBinary returns the cached resolved path, populating it on first use.
func (p *Plugin) deepseekBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveDeepSeekBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

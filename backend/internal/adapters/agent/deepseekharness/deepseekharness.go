// Package deepseekharness implements AO's DeepSeek Harness (dsh) agent adapter.
// It targets the official deepseek-ai/deepseek-harness runtime.
//
// The adapter is deliberately minimal:
//   - launches one official `dsh --profile headless` task and exits, so AO does
//     not need an interactive terminal protocol from the developer preview;
//   - does not attempt native resume, so GetRestoreCommand is false;
//   - does not consult or install hooks, so the inherited no-op GetAgentHooks
//     is correct.
package deepseekharness

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// adapterID is the registry id and the value users pass to
// `ao spawn --agent`. It matches domain.HarnessDeepSeek.
const adapterID = "deepseek-harness"

const promptlessOrchestratorPrompt = "Start an AO orchestrator session for this workspace."

// dshBinarySpec locates the official DeepSeek Harness CLI: PATH first, then the
// install-script and Homebrew locations, the standard Node-managed fallback
// paths, and the npm shims under %APPDATA% on Windows.
var dshBinarySpec = binaryutil.BinarySpec{
	Label:         "deepseek-harness",
	Names:         []string{"dsh"},
	WinNames:      []string{"dsh.cmd", "dsh.exe", "dsh"},
	UnixPaths:     []string{"/usr/local/bin/dsh", "/opt/homebrew/bin/dsh"},
	UnixHomePaths: binaryutil.NodeManagedUnixHomePaths("dsh"),
	NodeManaged:   true,
	WinPaths: []binaryutil.WinPath{
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "dsh.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "dsh.exe"}},
	},
}

// Plugin is the DeepSeek Harness agent adapter. It is safe for concurrent use;
// the binary path is resolved once and cached under binaryMu.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register DeepSeek Harness adapter.
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
		Name:        "DeepSeek",
		Description: "Run official DeepSeek Harness tasks (developer preview).",
		Version:     "0.0.1",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

// GetConfigSpec reports the fixed DeepSeek Harness profile AO launches. Model
// selection is owned by the DeepSeek Harness profile/settings, so AO exposes the
// runtime mode rather than a misleading raw-model field.
func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ConfigSpec{}, err
	}
	return ports.ConfigSpec{Fields: []ports.ConfigField{{
		Key:         "mode",
		Type:        ports.ConfigFieldEnum,
		Description: "DeepSeek Harness profile.",
		Default:     "headless",
		Enum:        []string{"headless"},
	}}}, nil
}

// GetLaunchCommand builds the argv to run a single official DeepSeek Harness task:
//
//	dsh --profile headless <prompt>
//
// The runtime sets cwd to cfg.WorkspacePath, matching every other shipped
// adapter.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) (cmd []string, err error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prompt := strings.TrimSpace(cfg.Prompt)
	if prompt == "" && cfg.Kind == domain.KindOrchestrator {
		prompt = promptlessOrchestratorPrompt
	}
	if prompt == "" {
		return nil, fmt.Errorf("deepseek-harness: initial prompt is required for headless profile")
	}

	binary, err := p.dshBinary(ctx)
	if err != nil {
		return nil, err
	}

	cmd = []string{binary, "--profile", "headless", prompt}
	return cmd, nil
}

// SessionInfo surfaces DeepSeek Harness metadata persisted by AO under the
// shared ports.MetadataKey* keys.
func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// ExitDetectionMode opts DeepSeek Harness into AO's process supervisor.
func (p *Plugin) ExitDetectionMode() ports.AgentExitDetectionMode {
	return ports.AgentExitDetectionSupervisor
}

// ResolveDSHBinary returns the path to the official `dsh` binary on this machine,
// searching PATH then a handful of well-known install locations. It returns a
// wrapped ports.ErrAgentBinaryNotFound when `dsh` is absent.
func ResolveDSHBinary(ctx context.Context) (string, error) {
	return binaryutil.ResolveBinary(ctx, dshBinarySpec)
}

// dshBinary returns the cached resolved path, populating it on first use.
func (p *Plugin) dshBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()

	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}

	binary, err := ResolveDSHBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

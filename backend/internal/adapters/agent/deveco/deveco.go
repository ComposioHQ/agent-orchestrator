// Package deveco implements the DevEco Code agent adapter. DevEco Code is an
// OpenCode-derived CLI, but it remains a separately registered AO agent with
// its own binary, configuration namespace, workspace extensions, and hooks.
package deveco

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/agentbase"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/binaryutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencodefamily"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	adapterID                    = "deveco"
	devecoAgentSessionIDMetadata = "agentSessionId"
	devecoConfigEnvVar           = "DEVECO_CONFIG"
	devecoTrustEnv               = "DEVECO_TRUST=1"
)

var devecoBinarySpec = binaryutil.BinarySpec{
	Label:    "deveco",
	Names:    []string{"deveco"},
	WinNames: []string{"deveco.exe", "deveco.cmd", "deveco.bat", "deveco"},
	UnixPaths: []string{
		"/usr/local/bin/deveco",
		"/opt/homebrew/bin/deveco",
	},
	UnixHomePaths: binaryutil.NodeManagedUnixHomePaths("deveco"),
	WinPaths: []binaryutil.WinPath{
		// The current native installer writes here.
		{Base: binaryutil.WinHome, Parts: []string{".local", "bin", "deveco.exe"}},
		// npm hoists the platform package beside @deveco/deveco-code.
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "node_modules", "@deveco", "deveco-code-windows-x64", "bin", "deveco.exe"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "node_modules", "@deveco", "deveco-code-windows-x64-baseline", "bin", "deveco.exe"}},
		// Some package-manager layouts keep optional dependencies nested.
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "node_modules", "@deveco", "deveco-code", "node_modules", "@deveco", "deveco-code-windows-x64", "bin", "deveco.exe"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "node_modules", "@deveco", "deveco-code", "node_modules", "@deveco", "deveco-code-windows-x64-baseline", "bin", "deveco.exe"}},
		// Keep documented npm shims as detection fallbacks. Standard DevEco
		// installs resolve one of the native payloads above first.
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "deveco.cmd"}},
		{Base: binaryutil.WinAppData, Parts: []string{"npm", "deveco.bat"}},
	},
	NodeManaged: true,
}

// Plugin is safe for concurrent readiness and launch probes.
type Plugin struct {
	agentbase.Base
	binaryMu       sync.Mutex
	resolvedBinary string
}

// New returns a ready-to-register DevEco Code adapter.
func New() *Plugin { return &Plugin{} }

var _ adapters.Adapter = (*Plugin)(nil)
var _ ports.Agent = (*Plugin)(nil)
var _ ports.AgentAuthChecker = (*Plugin)(nil)
var _ ports.AgentBinaryResolver = (*Plugin)(nil)

func (p *Plugin) Manifest() adapters.Manifest {
	return adapters.Manifest{
		ID:          adapterID,
		Name:        "DevEco Code",
		Description: "Run DevEco Code worker sessions for HarmonyOS projects.",
		Version:     "0.1.0",
		Capabilities: []adapters.Capability{
			adapters.CapabilityAgent,
		},
	}
}

func (p *Plugin) GetConfigSpec(ctx context.Context) (ports.ConfigSpec, error) {
	return agentbase.ModelConfigSpec(ctx, "Model override passed to `deveco --model`.")
}

// GetLaunchCommand uses DevEco's current TUI argv directly. AO's runtime sets
// cwd to the worker's worktree; no shell command string is constructed.
func (p *Plugin) GetLaunchCommand(ctx context.Context, cfg ports.LaunchConfig) ([]string, error) {
	binary, err := p.devecoBinary(ctx)
	if err != nil {
		return nil, err
	}
	envPrefix, agentName, err := devecoConfigEnvPrefix(cfg.SystemPrompt, cfg.SystemPromptFile, cfg.SessionID)
	if err != nil {
		return nil, err
	}
	cmd := appendDevEcoEnv(envPrefix)
	cmd = append(cmd, binary)
	appendPermissionFlags(&cmd, cfg.Permissions)
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	if agentName != "" {
		cmd = append(cmd, "--agent", agentName)
	}
	if cfg.Prompt != "" {
		cmd = append(cmd, "--prompt", cfg.Prompt)
	}
	return cmd, nil
}

// GetRestoreCommand continues the native DevEco session reported by the
// activity plugin, reapplying AO's per-session primary-agent configuration.
func (p *Plugin) GetRestoreCommand(ctx context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	agentSessionID := strings.TrimSpace(cfg.Session.Metadata[devecoAgentSessionIDMetadata])
	if agentSessionID == "" {
		return nil, false, nil
	}
	binary, err := p.devecoBinary(ctx)
	if err != nil {
		return nil, false, err
	}
	envPrefix, agentName, err := devecoConfigEnvPrefix(cfg.SystemPrompt, cfg.SystemPromptFile, cfg.Session.ID)
	if err != nil {
		return nil, false, err
	}
	cmd := appendDevEcoEnv(envPrefix)
	cmd = append(cmd, binary)
	appendPermissionFlags(&cmd, cfg.Permissions)
	agentbase.AppendModelFlag(&cmd, cfg.Config, "--model")
	if agentName != "" {
		cmd = append(cmd, "--agent", agentName)
	}
	cmd = append(cmd, "--session", agentSessionID)
	return cmd, true, nil
}

func (p *Plugin) SessionInfo(ctx context.Context, session ports.SessionRef) (ports.SessionInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.SessionInfo{}, false, err
	}
	info, ok := agentbase.StandardSessionInfo(session)
	return info, ok, nil
}

// DevEco can authenticate through its Huawei account or any configured
// OpenCode-compatible provider. Binary availability is authoritative here;
// the TUI owns login state and can guide the user when needed.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if _, err := p.devecoBinary(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	return ports.AgentAuthStatusUnknown, nil
}

func appendPermissionFlags(cmd *[]string, permissions ports.PermissionMode) {
	if ports.NormalizePermissionMode(permissions) == ports.PermissionModeBypassPermissions {
		*cmd = append(*cmd, "--dangerously-skip-permissions")
	}
}

func appendDevEcoEnv(prefix []string) []string {
	if len(prefix) == 0 {
		return []string{"env", devecoTrustEnv}
	}
	return append(prefix, devecoTrustEnv)
}

func devecoConfigEnvPrefix(inlinePrompt, promptFile, sessionID string) ([]string, string, error) {
	return opencodefamily.ConfigEnvPrefix("deveco", devecoConfigEnvVar, "deveco.json", inlinePrompt, promptFile, sessionID)
}

// ResolveDevEcoBinary searches native Windows payloads before npm shims, then
// falls back to the shared package-manager-aware resolver.
func ResolveDevEcoBinary(ctx context.Context) (string, error) {
	path, err := binaryutil.ResolveBinary(ctx, devecoBinarySpec)
	if err != nil {
		return "", err
	}
	if ext := strings.ToLower(filepath.Ext(path)); ext == ".cmd" || ext == ".bat" {
		// The documented npm package always includes a native platform payload.
		// Refuse to feed an arbitrary batch file (and the task prompt) through
		// cmd.exe; locate the native payload beside the shim instead.
		if native := nativePayloadBesideShim(path); native != "" {
			return native, nil
		}
		return "", fmt.Errorf("deveco: found Windows shim %s but not its native deveco.exe payload: %w", path, ports.ErrAgentBinaryNotFound)
	}
	return path, nil
}

func nativePayloadBesideShim(shim string) string {
	root := filepath.Dir(shim)
	candidates := []string{
		filepath.Join(root, "node_modules", "@deveco", "deveco-code-windows-x64", "bin", "deveco.exe"),
		filepath.Join(root, "node_modules", "@deveco", "deveco-code-windows-x64-baseline", "bin", "deveco.exe"),
		filepath.Join(root, "node_modules", "@deveco", "deveco-code", "node_modules", "@deveco", "deveco-code-windows-x64", "bin", "deveco.exe"),
		filepath.Join(root, "node_modules", "@deveco", "deveco-code", "node_modules", "@deveco", "deveco-code-windows-x64-baseline", "bin", "deveco.exe"),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func (p *Plugin) ResolveBinary(ctx context.Context) (string, error) {
	return p.devecoBinary(ctx)
}

func (p *Plugin) devecoBinary(ctx context.Context) (string, error) {
	p.binaryMu.Lock()
	defer p.binaryMu.Unlock()
	if p.resolvedBinary != "" {
		return p.resolvedBinary, nil
	}
	binary, err := ResolveDevEcoBinary(ctx)
	if err != nil {
		return "", err
	}
	p.resolvedBinary = binary
	return binary, nil
}

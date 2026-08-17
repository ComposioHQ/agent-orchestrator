package agy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	agyHooksDirName      = ".agents"
	agyHooksFileName     = "hooks.json"
	agyManagedHookName   = "agent-orchestrator-tui"
	agyHookCommandSuffix = " hooks agy "
	agyHookTimeout       = 30
)

var agyCurrentExecutable = os.Executable

// Antigravity workspace hooks use a named hook-set at the top level of
// <workspace>/.agents/hooks.json. Pre/PostToolUse use matcher groups; the
// invocation and Stop events use a flat list of handlers.
type agyHookFile map[string]json.RawMessage

type agyHookDefinition struct {
	PreInvocation []agyHookEntry        `json:"PreInvocation,omitempty"`
	PostToolUse   []agyHookMatcherGroup `json:"PostToolUse,omitempty"`
	Stop          []agyHookEntry        `json:"Stop,omitempty"`
}

type agyHookMatcherGroup struct {
	Matcher string         `json:"matcher"`
	Hooks   []agyHookEntry `json:"hooks"`
}

type agyHookEntry struct {
	Type    string `json:"type,omitempty"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

// GetAgentHooks installs AO's Agy TUI hooks into the current Antigravity
// workspace hook file. Existing named hook sets (including the Agy Chat
// driver's agent-orchestrator-chat set) are preserved byte-for-byte at the
// semantic JSON level.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("agy.GetAgentHooks: WorkspacePath is required")
	}

	hookCommandPrefix, err := agyHookCommandPrefix()
	if err != nil {
		return fmt.Errorf("agy.GetAgentHooks: resolve AO hook executable: %w", err)
	}

	hooksPath := agyHooksPath(cfg.WorkspacePath)
	file, err := readAgyHookFile(hooksPath)
	if err != nil {
		return fmt.Errorf("agy.GetAgentHooks: %w", err)
	}

	definition := agyHookDefinition{
		PreInvocation: []agyHookEntry{{
			Type: "command", Command: hookCommandPrefix + "pre-invocation", Timeout: agyHookTimeout,
		}},
		PostToolUse: []agyHookMatcherGroup{{
			Matcher: "*",
			Hooks: []agyHookEntry{{
				Type: "command", Command: hookCommandPrefix + "post-tool-use", Timeout: agyHookTimeout,
			}},
		}},
		Stop: []agyHookEntry{{
			Type: "command", Command: hookCommandPrefix + "stop", Timeout: agyHookTimeout,
		}},
	}
	raw, err := json.Marshal(definition)
	if err != nil {
		return fmt.Errorf("agy.GetAgentHooks: encode managed hooks: %w", err)
	}
	file[agyManagedHookName] = raw

	if err := writeAgyHookFile(hooksPath, file); err != nil {
		return fmt.Errorf("agy.GetAgentHooks: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(hooksPath), agyHooksFileName); err != nil {
		return fmt.Errorf("agy.GetAgentHooks: gitignore: %w", err)
	}
	return nil
}

// UninstallHooks removes only AO's TUI hook set. Other Antigravity hook sets,
// including user hooks and AO's independent Chat hook set, remain untouched.
func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("agy.UninstallHooks: workspacePath is required")
	}

	hooksPath := agyHooksPath(workspacePath)
	if _, err := os.Stat(hooksPath); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	file, err := readAgyHookFile(hooksPath)
	if err != nil {
		return fmt.Errorf("agy.UninstallHooks: %w", err)
	}
	delete(file, agyManagedHookName)
	if err := writeAgyHookFile(hooksPath, file); err != nil {
		return fmt.Errorf("agy.UninstallHooks: %w", err)
	}
	return nil
}

// AreHooksInstalled reports whether the current Antigravity workspace file
// contains AO's TUI hook set with commands pointing at this exact AO binary.
// A legacy bare `ao hooks agy ...` command deliberately does not count: desktop
// launches may not put AO on PATH, so those stale hook sets must be refreshed.
func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("agy.AreHooksInstalled: workspacePath is required")
	}

	hooksPath := agyHooksPath(workspacePath)
	if _, err := os.Stat(hooksPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	file, err := readAgyHookFile(hooksPath)
	if err != nil {
		return false, fmt.Errorf("agy.AreHooksInstalled: %w", err)
	}
	raw, ok := file[agyManagedHookName]
	if !ok {
		return false, nil
	}
	var definition agyHookDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		return false, fmt.Errorf("agy.AreHooksInstalled: parse managed hook set: %w", err)
	}
	hookCommandPrefix, err := agyHookCommandPrefix()
	if err != nil {
		return false, fmt.Errorf("agy.AreHooksInstalled: resolve AO hook executable: %w", err)
	}
	return agyDefinitionHasManagedHooks(definition, hookCommandPrefix), nil
}

func agyHooksPath(workspacePath string) string {
	return filepath.Join(workspacePath, agyHooksDirName, agyHooksFileName)
}

func readAgyHookFile(hooksPath string) (agyHookFile, error) {
	file := agyHookFile{}
	data, err := os.ReadFile(hooksPath) //nolint:gosec // path is rooted in caller-owned workspace
	if errors.Is(err, os.ErrNotExist) {
		return file, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", hooksPath, err)
	}
	if strings.TrimSpace(string(data)) == "" {
		return file, nil
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse %s: %w", hooksPath, err)
	}
	if file == nil {
		file = agyHookFile{}
	}
	return file, nil
}

func writeAgyHookFile(hooksPath string, file agyHookFile) error {
	if err := os.MkdirAll(filepath.Dir(hooksPath), 0o750); err != nil {
		return fmt.Errorf("create hook dir: %w", err)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", hooksPath, err)
	}
	data = append(data, '\n')
	if err := hookutil.AtomicWriteFile(hooksPath, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", hooksPath, err)
	}
	return nil
}

func agyHookCommandPrefix() (string, error) {
	executable, err := agyCurrentExecutable()
	if err != nil {
		return "", err
	}
	executable = strings.TrimSpace(executable)
	if executable == "" {
		return "", errors.New("current AO executable path is empty")
	}
	return quoteHookExecutable(executable) + agyHookCommandSuffix, nil
}

func quoteHookExecutable(path string) string {
	if runtime.GOOS == "windows" {
		return `"` + path + `"`
	}
	return "'" + strings.ReplaceAll(path, "'", "'\"'\"'") + "'"
}

func agyDefinitionHasManagedHooks(definition agyHookDefinition, prefix string) bool {
	wantPre := prefix + "pre-invocation"
	wantPost := prefix + "post-tool-use"
	wantStop := prefix + "stop"

	hasPre := false
	for _, hook := range definition.PreInvocation {
		if strings.TrimSpace(hook.Command) == wantPre {
			hasPre = true
			break
		}
	}

	hasPost := false
	for _, group := range definition.PostToolUse {
		if group.Matcher != "*" {
			continue
		}
		for _, hook := range group.Hooks {
			if strings.TrimSpace(hook.Command) == wantPost {
				hasPost = true
				break
			}
		}
		if hasPost {
			break
		}
	}

	hasStop := false
	for _, hook := range definition.Stop {
		if strings.TrimSpace(hook.Command) == wantStop {
			hasStop = true
			break
		}
	}

	return hasPre && hasPost && hasStop
}

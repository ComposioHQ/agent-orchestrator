package deveco

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	_ "embed"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/skillassets"
)

const (
	devecoConfigDirName     = ".deveco"
	devecoPluginSubDir      = "plugins"
	devecoPluginFileName    = "ao-activity.ts"
	devecoPluginSentinel    = "agent-orchestrator: managed deveco activity plugin"
	devecoHookCommandPrefix = "ao hooks deveco "
	devecoSkillSubDir       = "skills"
	devecoSkillMarkerFile   = ".using-ao.ao-managed"
	devecoSkillSentinel     = "agent-orchestrator: managed deveco using-ao skill"
)

//go:embed assets/ao-activity.ts
var devecoPluginSource string

var devecoManagedEvents = []string{"session-start", "user-prompt-submit", "active", "stop", "permission-blocked"}

// GetAgentHooks installs DevEco's workspace-local plugin and AO skill under
// .deveco. DevEco's current ConfigPlugin and Skill loaders scan these exact
// directories. User-owned files are never overwritten.
func (p *Plugin) GetAgentHooks(ctx context.Context, cfg ports.WorkspaceHookConfig) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.WorkspacePath) == "" {
		return errors.New("deveco.GetAgentHooks: WorkspacePath is required")
	}

	pluginPath := devecoPluginPath(cfg.WorkspacePath)
	if _, err := os.Stat(pluginPath); err == nil {
		managed, err := isAOManagedPlugin(pluginPath)
		if err != nil {
			return fmt.Errorf("deveco.GetAgentHooks: %w", err)
		}
		if !managed {
			return fmt.Errorf("deveco.GetAgentHooks: refusing to overwrite non-AO file at %s — move it so AO can install its plugin", pluginPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("deveco.GetAgentHooks: stat plugin: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(pluginPath), 0o750); err != nil {
		return fmt.Errorf("deveco.GetAgentHooks: create plugin dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(pluginPath, []byte(devecoPluginSource), 0o600); err != nil {
		return fmt.Errorf("deveco.GetAgentHooks: write plugin: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(filepath.Dir(pluginPath), devecoPluginFileName); err != nil {
		return fmt.Errorf("deveco.GetAgentHooks: gitignore: %w", err)
	}
	if err := installUsingAOSkill(cfg.WorkspacePath); err != nil {
		return fmt.Errorf("deveco.GetAgentHooks: %w", err)
	}
	return nil
}

func (p *Plugin) UninstallHooks(ctx context.Context, workspacePath string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return errors.New("deveco.UninstallHooks: workspacePath is required")
	}
	pluginPath := devecoPluginPath(workspacePath)
	managed, err := isAOManagedPlugin(pluginPath)
	if err != nil {
		return fmt.Errorf("deveco.UninstallHooks: %w", err)
	}
	if managed {
		if err := os.Remove(pluginPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("deveco.UninstallHooks: remove plugin: %w", err)
		}
	}
	if err := uninstallUsingAOSkill(workspacePath); err != nil {
		return fmt.Errorf("deveco.UninstallHooks: %w", err)
	}
	return nil
}

func (p *Plugin) AreHooksInstalled(ctx context.Context, workspacePath string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if strings.TrimSpace(workspacePath) == "" {
		return false, errors.New("deveco.AreHooksInstalled: workspacePath is required")
	}
	managed, err := isAOManagedPlugin(devecoPluginPath(workspacePath))
	if err != nil {
		return false, fmt.Errorf("deveco.AreHooksInstalled: %w", err)
	}
	return managed, nil
}

func devecoPluginPath(workspacePath string) string {
	return filepath.Join(workspacePath, devecoConfigDirName, devecoPluginSubDir, devecoPluginFileName)
}

func devecoSkillsDir(workspacePath string) string {
	return filepath.Join(workspacePath, devecoConfigDirName, devecoSkillSubDir)
}

func devecoSkillDir(workspacePath string) string {
	return filepath.Join(devecoSkillsDir(workspacePath), skillassets.SkillName)
}

func devecoSkillMarkerPath(workspacePath string) string {
	return filepath.Join(devecoSkillsDir(workspacePath), devecoSkillMarkerFile)
}

func installUsingAOSkill(workspacePath string) error {
	skillDir := devecoSkillDir(workspacePath)
	if info, err := os.Stat(skillDir); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("refusing to overwrite non-directory at %s — move it so AO can install using-ao", skillDir)
		}
		managed, err := isAOManagedSkill(workspacePath)
		if err != nil {
			return err
		}
		if !managed {
			return fmt.Errorf("refusing to overwrite non-AO skill at %s — move it so AO can install using-ao", skillDir)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat skill dir: %w", err)
	}

	skillsParent := devecoSkillsDir(workspacePath)
	if err := os.MkdirAll(skillsParent, 0o750); err != nil {
		return fmt.Errorf("create skills dir: %w", err)
	}
	if err := hookutil.AtomicWriteFile(devecoSkillMarkerPath(workspacePath), []byte(devecoSkillSentinel+"\n"), 0o600); err != nil {
		return fmt.Errorf("write skill marker: %w", err)
	}
	if err := skillassets.Materialize(skillDir); err != nil {
		return fmt.Errorf("materialize using-ao skill: %w", err)
	}
	if err := ensureSkillTreeGitignored(skillDir); err != nil {
		return fmt.Errorf("skill gitignore: %w", err)
	}
	if err := hookutil.EnsureWorkspaceGitignore(skillsParent, devecoSkillMarkerFile); err != nil {
		return fmt.Errorf("skill marker gitignore: %w", err)
	}
	return nil
}

func ensureSkillTreeGitignored(skillRoot string) error {
	byDir := map[string][]string{}
	err := filepath.WalkDir(skillRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		byDir[filepath.Dir(path)] = append(byDir[filepath.Dir(path)], filepath.Base(path))
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk skill tree: %w", err)
	}
	for dir, names := range byDir {
		if err := hookutil.EnsureWorkspaceGitignore(dir, names...); err != nil {
			return err
		}
	}
	return nil
}

func uninstallUsingAOSkill(workspacePath string) error {
	managed, err := isAOManagedSkill(workspacePath)
	if err != nil || !managed {
		return err
	}
	if err := os.RemoveAll(devecoSkillDir(workspacePath)); err != nil {
		return fmt.Errorf("remove skill dir: %w", err)
	}
	if err := os.Remove(devecoSkillMarkerPath(workspacePath)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove skill marker: %w", err)
	}
	return nil
}

func isAOManagedPlugin(path string) (bool, error) {
	data, err := os.ReadFile(path) //nolint:gosec // caller-owned workspace
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read %s: %w", path, err)
	}
	return strings.Contains(string(data), devecoPluginSentinel), nil
}

func isAOManagedSkill(workspacePath string) (bool, error) {
	data, err := os.ReadFile(devecoSkillMarkerPath(workspacePath)) //nolint:gosec // caller-owned workspace
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read skill marker: %w", err)
	}
	return strings.Contains(string(data), devecoSkillSentinel), nil
}

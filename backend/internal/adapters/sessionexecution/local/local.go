package local

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/attachmentstore"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

type Config struct {
	Workspace ports.Workspace
	Runtime   ports.Runtime
	Messenger ports.AgentMessenger
	DataDir   string
	LookPath  func(string) (string, error)
	Logger    *slog.Logger
	// AugmentPATH preserves the manager's platform-specific PATH behavior.
	AugmentPATH func(context.Context, map[string]string, []string)
	// ResolveDiffBase preserves the manager's existing Git comparison logic.
	ResolveDiffBase func(context.Context, string, string) (string, string)
}

type Execution struct {
	workspace       ports.Workspace
	runtime         ports.Runtime
	messenger       ports.AgentMessenger
	attachments     *attachmentstore.Store
	dataDir         string
	lookPath        func(string) (string, error)
	logger          *slog.Logger
	augmentPATH     func(context.Context, map[string]string, []string)
	resolveDiffBase func(context.Context, string, string) (string, string)
}

var _ ports.SessionExecution = (*Execution)(nil)

func New(cfg Config) *Execution {
	lookPath := cfg.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Execution{
		workspace: cfg.Workspace, runtime: cfg.Runtime, messenger: cfg.Messenger,
		attachments: attachmentstore.New(cfg.DataDir), dataDir: cfg.DataDir,
		lookPath: lookPath, logger: logger, augmentPATH: cfg.AugmentPATH,
		resolveDiffBase: cfg.ResolveDiffBase,
	}
}

func (e *Execution) Workspace() ports.Workspace      { return e.workspace }
func (e *Execution) Runtime() ports.Runtime          { return e.runtime }
func (e *Execution) Messenger() ports.AgentMessenger { return e.messenger }
func (e *Execution) BeginSession(_ context.Context, spec ports.ExecutionSpec) (ports.SessionProvision, error) {
	return &provision{Execution: e, spec: spec}, nil
}

func (e *Execution) ValidateHostPrerequisites(context.Context) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	if path, err := e.lookPath("tmux"); err != nil || path == "" {
		return fmt.Errorf("%w: tmux required on macOS/Linux but not in PATH", ports.ErrRuntimePrerequisite)
	}
	return nil
}

func (e *Execution) ReadProjectFile(_ context.Context, projectPath, rel string) ([]byte, error) {
	clean, err := safeRelPath(rel)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(filepath.Join(projectPath, clean)) //nolint:gosec // confined above
}

func (e *Execution) StageSystemPrompt(_ context.Context, id domain.SessionID, prompt string) (string, error) {
	if prompt == "" || strings.TrimSpace(e.dataDir) == "" {
		return "", nil
	}
	path := filepath.Join(e.dataDir, "prompts", string(id), "system.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(strings.TrimRight(prompt, "\n")+"\n"), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

func (e *Execution) DiscardSystemPrompt(_ context.Context, id domain.SessionID) {
	if strings.TrimSpace(e.dataDir) == "" {
		return
	}
	dir := filepath.Join(e.dataDir, "prompts", string(id))
	if err := os.RemoveAll(dir); err != nil {
		e.logger.Warn("system prompt cleanup failed", "session", id, "path", dir, "err", err)
	}
}

func (e *Execution) StageAttachments(ctx context.Context, id domain.SessionID, workspacePath string, attachments []ports.SpawnAttachment) ([]string, error) {
	refs := make([]string, 0, len(attachments))
	for i, attachment := range attachments {
		ext := attachment.Ext
		if ext == "" {
			ext = ".bin"
		}
		name := fmt.Sprintf("attachment-%d%s", i+1, ext)
		if err := e.attachments.Put(ctx, id, workspacePath, name, attachment.Data); err != nil {
			return nil, fmt.Errorf("write attachment %d: %w", i+1, err)
		}
		refs = append(refs, attachmentstore.WorkspaceDir+"/"+name)
	}
	return refs, nil
}

func (e *Execution) PutAttachment(ctx context.Context, id domain.SessionID, workspacePath, name string, data []byte) error {
	return e.attachments.Put(ctx, id, workspacePath, name, data)
}

func (e *Execution) ImportAttachments(ctx context.Context, id domain.SessionID, workspacePath string) error {
	if workspacePath == "" {
		return nil
	}
	return e.attachments.ImportWorkspace(ctx, id, workspacePath)
}

func (e *Execution) RestoreAttachments(ctx context.Context, id domain.SessionID, workspacePath string) (bool, error) {
	return e.attachments.MaterializeWorkspace(ctx, id, workspacePath)
}

func (e *Execution) RemoveAttachments(ctx context.Context, id domain.SessionID) error {
	return e.attachments.RemoveSession(ctx, id)
}

func (e *Execution) Provision(ctx context.Context, spec ports.WorkspaceProvisionSpec) error {
	if err := applySymlinks(spec.ProjectPath, spec.WorkspacePath, spec.Symlinks); err != nil {
		return err
	}
	for _, command := range spec.PostCreate {
		command = strings.TrimSpace(command)
		if command == "" {
			continue
		}
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = aoprocess.CommandContext(ctx, "cmd", "/c", command)
		} else {
			cmd = aoprocess.CommandContext(ctx, "sh", "-c", command)
		}
		cmd.Dir = spec.WorkspacePath
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("postCreate %q: %w: %s", command, err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

type preLauncher interface {
	PreLaunch(context.Context, ports.LaunchConfig) error
}
type workspaceCleaner interface {
	CleanupWorkspace(context.Context, ports.WorkspaceHookConfig) error
}

func (e *Execution) InstallAgentHooks(ctx context.Context, spec ports.AgentPrepareSpec) error {
	if spec.Agent == nil {
		return nil
	}
	if err := spec.Agent.GetAgentHooks(ctx, spec.Hooks); err != nil {
		e.removeAgentStateBestEffort(ctx, spec)
		return fmt.Errorf("install hooks: %w", err)
	}
	if launcher, ok := spec.Agent.(preLauncher); ok {
		if err := launcher.PreLaunch(ctx, spec.PreLaunch); err != nil {
			e.removeAgentStateBestEffort(ctx, spec)
			return fmt.Errorf("pre-launch: %w", err)
		}
	}
	return nil
}

func (e *Execution) removeAgentStateBestEffort(ctx context.Context, spec ports.AgentPrepareSpec) {
	if err := e.RemoveAgentState(ctx, spec); err != nil {
		e.logger.Warn("session prepare rollback: failed to clean agent workspace state", "session", spec.SessionID, "workspacePath", spec.Hooks.WorkspacePath, "error", err)
	}
}

func (e *Execution) RemoveAgentState(ctx context.Context, spec ports.AgentPrepareSpec) error {
	cleaner, ok := spec.Agent.(workspaceCleaner)
	if !ok {
		return nil
	}
	return cleaner.CleanupWorkspace(ctx, spec.Hooks)
}

func (e *Execution) ResolveLaunchBinary(ctx context.Context, argv []string, env map[string]string) (map[string]string, error) {
	bin, ok := launchBinary(argv)
	if !ok {
		return env, fmt.Errorf("agent: launch argv missing binary: %w", ports.ErrAgentBinaryNotFound)
	}
	if _, err := e.lookPath(bin); err != nil {
		return env, fmt.Errorf("agent binary %q: %w", bin, ports.ErrAgentBinaryNotFound)
	}
	if e.augmentPATH != nil {
		e.augmentPATH(ctx, env, argv)
	}
	return env, nil
}

func launchBinary(argv []string) (string, bool) {
	if len(argv) == 0 {
		return "", false
	}
	if filepath.Base(argv[0]) != "env" {
		return argv[0], true
	}
	for _, arg := range argv[1:] {
		if strings.Contains(arg, "=") {
			continue
		}
		return arg, true
	}
	return "", false
}

func (e *Execution) BindRuntimeConfig(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeConfig, error) {
	return cfg, nil
}

func (e *Execution) ObserveWorkspace(ctx context.Context, info ports.WorkspaceInfo) (ports.WorkspaceObservation, bool, error) {
	observer, ok := e.workspace.(ports.WorkspaceObserver)
	if !ok {
		return ports.WorkspaceObservation{}, false, nil
	}
	observation, err := observer.ObserveWorkspace(ctx, info)
	return observation, true, err
}

func (e *Execution) ResolveDiffBase(ctx context.Context, workspacePath, defaultBranch string) (string, string) {
	if e.resolveDiffBase == nil {
		return "", ""
	}
	return e.resolveDiffBase(ctx, workspacePath, defaultBranch)
}

type provision struct {
	*Execution
	spec       ports.ExecutionSpec
	info       ports.WorkspaceInfo
	project    *ports.WorkspaceProjectInfo
	created    bool
	committed  bool
	rolledBack bool
}

var _ ports.SessionProvision = (*provision)(nil)

func (p *provision) CreateWorkspace(ctx context.Context, spec ports.WorkspaceCreateSpec) (ports.WorkspaceInfo, *ports.WorkspaceProjectInfo, error) {
	if spec.Project == nil {
		info, err := p.workspace.Create(ctx, spec.Workspace)
		if err != nil {
			return ports.WorkspaceInfo{}, nil, err
		}
		p.info, p.created = info, true
		return info, nil, nil
	}
	workspaceProject, ok := p.workspace.(ports.WorkspaceProject)
	if !ok {
		return ports.WorkspaceInfo{}, nil, ports.ErrWorkspaceProjectUnsupported
	}
	info, err := workspaceProject.CreateWorkspaceProject(ctx, *spec.Project)
	if err != nil {
		return ports.WorkspaceInfo{}, nil, err
	}
	p.info, p.project, p.created = info.Root, &info, true
	return info.Root, &info, nil
}

func (p *provision) LaunchRuntime(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	return p.runtime.Create(ctx, cfg)
}

func (p *provision) Commit(context.Context) error {
	p.committed = true
	return nil
}

func (p *provision) Rollback(ctx context.Context, _ ports.RollbackOptions) ports.RollbackOutcome {
	if p.committed || p.rolledBack || !p.created {
		return ports.RollbackOutcome{WorkspaceDestroyed: !p.committed}
	}
	var err error
	if p.project != nil {
		if workspaceProject, ok := p.workspace.(ports.WorkspaceProject); ok {
			err = workspaceProject.DestroyWorkspaceProject(ctx, *p.project)
		} else {
			err = p.workspace.Destroy(ctx, p.info)
		}
	} else {
		err = p.workspace.Destroy(ctx, p.info)
	}
	p.rolledBack = err == nil
	return ports.RollbackOutcome{WorkspaceDestroyed: p.rolledBack}
}

func applySymlinks(projectPath, workspacePath string, symlinks []string) error {
	for _, rel := range symlinks {
		rel = strings.TrimSpace(rel)
		if rel == "" {
			continue
		}
		clean, err := safeRelPath(rel)
		if err != nil {
			return fmt.Errorf("symlink %q: %w", rel, err)
		}
		source := filepath.Join(projectPath, clean)
		if _, err := os.Stat(source); err != nil {
			continue
		}
		target := filepath.Join(workspacePath, clean)
		if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
			return fmt.Errorf("symlink %q: %w", rel, err)
		}
		if _, err := os.Lstat(target); err == nil {
			continue
		}
		if err := os.Symlink(source, target); err != nil {
			return fmt.Errorf("symlink %q: %w", rel, err)
		}
	}
	return nil
}

func safeRelPath(rel string) (string, error) {
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, `\`) {
		return "", fmt.Errorf("path must be repo-relative")
	}
	clean := filepath.Clean(rel)
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || clean == "." || clean == "" {
		return "", fmt.Errorf("path must be repo-relative")
	}
	for _, segment := range strings.Split(filepath.ToSlash(clean), "/") {
		if segment == ".." {
			return "", fmt.Errorf("path must be repo-relative")
		}
	}
	return clean, nil
}

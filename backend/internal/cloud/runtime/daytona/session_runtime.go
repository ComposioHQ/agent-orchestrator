package daytona

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	daytonasdk "github.com/daytona/clients/sdk-go/pkg/daytona"
	"github.com/daytona/clients/sdk-go/pkg/options"
	"github.com/daytona/clients/sdk-go/pkg/types"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/harnesscatalog"
)

const sessionName = "ao-agent"

var environmentKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ProvisionSessionRuntime creates exactly one sandbox for one AO session. The
// same path is used for orchestrators and workers; no agent ever shares compute
// with another session or with the project coordinator.
func (p *Provider) ProvisionSessionRuntime(ctx context.Context, workspace domain.Workspace, launch domain.RuntimeLaunch) (string, error) {
	zero := 0
	sandbox, err := p.client.Create(ctx, types.SnapshotParams{
		Snapshot: "daytona-small",
		SandboxBaseParams: types.SandboxBaseParams{
			Name: sessionSandboxName(workspace.ID, launch.SessionID),
			Labels: map[string]string{
				"ao.cloud.workspace": workspace.ID,
				"ao.cloud.session":   launch.SessionID,
			},
			AutoPauseInterval: &zero,
		},
	}, options.WithTimeout(5*time.Minute))
	if err != nil {
		return "", fmt.Errorf("create Daytona session sandbox: %w", err)
	}
	if err = p.bootstrapSessionRuntime(ctx, sandbox, workspace, launch); err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
		defer cancel()
		if cleanupErr := sandbox.Delete(cleanupCtx); cleanupErr != nil {
			return "", errors.Join(err, fmt.Errorf("delete failed Daytona session sandbox %q: %w", sandbox.ID, cleanupErr))
		}
		return "", err
	}
	return sandbox.ID, nil
}

func sessionSandboxName(workspaceID, sessionID string) string {
	shortWorkspaceID := strings.ReplaceAll(workspaceID, "-", "")
	if len(shortWorkspaceID) > 12 {
		shortWorkspaceID = shortWorkspaceID[:12]
	}
	shortSessionID := strings.ReplaceAll(sessionID, "-", "")
	if len(shortSessionID) > 12 {
		shortSessionID = shortSessionID[:12]
	}
	return "ao-session-" + shortWorkspaceID + "-" + shortSessionID
}

func (p *Provider) bootstrapSessionRuntime(ctx context.Context, sandbox *daytonasdk.Sandbox, workspace domain.Workspace, launch domain.RuntimeLaunch) error {
	harness, ok := harnesscatalog.DetectLaunch(launch.Argv)
	if !ok {
		return errors.New("cloud harness is not provisionable")
	}
	homeResult, err := run(ctx, sandbox, `printf %s "$HOME"`, time.Minute)
	if err != nil {
		return err
	}
	home := strings.TrimSpace(homeResult)
	if home == "" || !filepath.IsAbs(home) {
		return errors.New("daytona sandbox returned an invalid home directory") //nolint:staticcheck // Daytona is a product name.
	}
	root := filepath.Join(home, "workspace")
	archivePath := filepath.Join(home, ".ao", "workspace.tar.gz")
	credentialPath := filepath.Join(home, harness.CredentialRelativePath)
	githubTokenPath := filepath.Join(home, ".ao", "github-token")
	askpassPath := filepath.Join(home, ".ao", "github-askpass")
	aoPath := filepath.Join(home, "bin", "ao")
	filesRoot := filepath.Join(home, ".ao", "runtime-files")

	if _, err = run(ctx, sandbox, `sudo apt-get update -qq && sudo apt-get install -y -qq ca-certificates curl git tmux`, 10*time.Minute); err != nil {
		return fmt.Errorf("install session dependencies: %w", err)
	}
	if _, err = run(ctx, sandbox, harness.InstallCommand, 10*time.Minute); err != nil {
		return fmt.Errorf("install cloud harness %s: %w", harness.ID, err)
	}
	executableResult, err := run(ctx, sandbox, "command -v "+shellQuote(harness.Executable), time.Minute)
	if err != nil {
		return fmt.Errorf("resolve sandbox harness executable: %w", err)
	}
	executable := strings.TrimSpace(executableResult)
	if !filepath.IsAbs(executable) {
		return errors.New("sandbox returned an invalid harness executable path")
	}
	if _, err = run(ctx, sandbox, "mkdir -p "+shellQuote(filepath.Dir(archivePath))+" "+shellQuote(filepath.Dir(credentialPath))+" "+shellQuote(filepath.Dir(aoPath))+" "+shellQuote(filesRoot), time.Minute); err != nil {
		return err
	}
	if err = sandbox.FileSystem.UploadFile(ctx, p.aoBinary, aoPath); err != nil {
		return fmt.Errorf("upload AO binary: %w", err)
	}
	if harness.CredentialKind != harnesscatalog.CredentialClaudeOAuth {
		return fmt.Errorf("cloud harness %s has no credential adapter", harness.ID)
	}
	if err = sandbox.FileSystem.UploadFile(ctx, launch.ClaudeCredentials, credentialPath); err != nil {
		return fmt.Errorf("upload harness credentials: %w", err)
	}
	claudeConfig, err := sandboxClaudeConfig(root)
	if err != nil {
		return err
	}
	if err := sandbox.FileSystem.UploadFile(ctx, claudeConfig, filepath.Join(home, ".claude.json")); err != nil {
		return err
	}
	if len(p.githubToken) > 0 {
		if err := sandbox.FileSystem.UploadFile(ctx, p.githubToken, githubTokenPath); err != nil {
			return err
		}
		askpass := "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' x-access-token ;; *) cat " + shellQuote(githubTokenPath) + " ;; esac\n"
		if err := sandbox.FileSystem.UploadFile(ctx, []byte(askpass), askpassPath); err != nil {
			return err
		}
	}
	if _, err = run(ctx, sandbox, "chmod 0755 "+shellQuote(aoPath)+" "+shellQuote(askpassPath)+" && chmod 0600 "+shellQuote(credentialPath)+" "+shellQuote(githubTokenPath), time.Minute); err != nil {
		return err
	}

	clone := "GIT_TERMINAL_PROMPT=0"
	if len(p.githubToken) > 0 {
		clone += " GIT_ASKPASS=" + shellQuote(askpassPath)
	}
	clone += " git clone " + shellQuote(workspace.RepositoryURL) + " " + shellQuote(root)
	if _, err = run(ctx, sandbox, clone, 10*time.Minute); err != nil {
		return fmt.Errorf("clone session repository: %w", err)
	}
	if launch.Branch != "" {
		checkout := "git -C " + shellQuote(root) + " checkout -B " + shellQuote(launch.Branch)
		if workspace.RepositoryRef != "" {
			checkout += " " + shellQuote("origin/"+workspace.RepositoryRef)
		}
		if _, err = run(ctx, sandbox, checkout, 2*time.Minute); err != nil {
			return fmt.Errorf("create session branch: %w", err)
		}
	}
	if len(launch.WorkspaceArchive) > 0 {
		if err = sandbox.FileSystem.UploadFile(ctx, launch.WorkspaceArchive, archivePath); err != nil {
			return fmt.Errorf("upload prepared workspace: %w", err)
		}
		if _, err = run(ctx, sandbox, "tar -xzf "+shellQuote(archivePath)+" -C "+shellQuote(root)+" && rm -f "+shellQuote(archivePath), 3*time.Minute); err != nil {
			return fmt.Errorf("extract prepared workspace: %w", err)
		}
	}

	argv := append([]string(nil), launch.Argv...)
	pathMap := map[string]string{launch.SourceWorkspace: root}
	for _, argument := range argv {
		if replacement, ok := sandboxProvidedCommand(argument, harness); ok {
			// The harness is installed during sandbox bootstrap. The coordinator's
			// absolute executable path is host-specific and must not be uploaded or
			// invoked inside the isolated runtime.
			pathMap[argument] = replacement
		}
	}
	for i, file := range launch.Files {
		destination := filepath.Join(filesRoot, strconv.Itoa(i)+"-"+filepath.Base(file.SourcePath))
		if err = sandbox.FileSystem.UploadFile(ctx, file.Data, destination); err != nil {
			return fmt.Errorf("upload runtime file: %w", err)
		}
		pathMap[file.SourcePath] = destination
	}
	if len(argv) > 0 && filepath.IsAbs(argv[0]) {
		pathMap[argv[0]] = aoPath
	}
	for index := range argv {
		argv[index] = replaceRuntimePaths(argv[index], pathMap)
	}
	env := make(map[string]string, len(launch.Env)+3)
	for key, value := range launch.Env {
		// Coordinator-only endpoints and filesystem roots cannot be reached from
		// isolated compute. Provider credentials are supplied separately.
		if !environmentKeyPattern.MatchString(key) || strings.HasPrefix(key, "AO_BROWSER_CAPABILITY") {
			continue
		}
		env[key] = replaceRuntimePaths(value, pathMap)
	}
	env["HOME"] = home
	env["TERM"] = "xterm-256color"
	env["PATH"] = sandboxPATH(home, executable)
	coordinatorURL, err := p.previewURL(ctx, workspace.SandboxID, 24*time.Hour)
	if err != nil {
		return fmt.Errorf("create coordinator capability: %w", err)
	}
	env["AO_CLOUD_COORDINATOR_URL"] = coordinatorURL
	command := "cd " + shellQuote(root) + " && exec env"
	for _, key := range sortedKeys(env) {
		command += " " + key + "=" + shellQuote(env[key])
	}
	for _, arg := range argv {
		command += " " + shellQuote(arg)
	}
	start := "tmux new-session -d -s " + shellQuote(sessionName) + " " + shellQuote(command)
	if _, err = run(ctx, sandbox, start, time.Minute); err != nil {
		return fmt.Errorf("start isolated agent session: %w", err)
	}
	return nil
}

// DeleteSessionRuntime removes all compute and disk for one agent session.
func (p *Provider) DeleteSessionRuntime(ctx context.Context, sandboxID string) error {
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return fmt.Errorf("get Daytona session sandbox: %w", err)
	}
	if err = sandbox.Delete(ctx); err != nil {
		return fmt.Errorf("delete Daytona session sandbox: %w", err)
	}
	return nil
}

// SessionRuntimeAlive probes the agent's tmux session.
func (p *Provider) SessionRuntimeAlive(ctx context.Context, sandboxID string) (bool, error) {
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return false, fmt.Errorf("get Daytona session sandbox: %w", err)
	}
	result, err := sandbox.Process.ExecuteCommand(ctx, "tmux has-session -t "+shellQuote(sessionName), options.WithExecuteTimeout(time.Minute))
	if err != nil {
		return false, err
	}
	return result.ExitCode == 0, nil
}

// SessionRuntimeOutput captures bounded terminal history.
func (p *Provider) SessionRuntimeOutput(ctx context.Context, sandboxID string, lines int) (string, error) {
	if lines <= 0 {
		lines = 200
	}
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return "", err
	}
	return run(ctx, sandbox, "tmux capture-pane -p -e -t "+shellQuote(sessionName)+" -S -"+strconv.Itoa(lines), time.Minute)
}

// SessionRuntimeInput pastes input and optionally submits it.
func (p *Provider) SessionRuntimeInput(ctx context.Context, sandboxID, input string, enter bool) error {
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return err
	}
	command := "tmux set-buffer -- " + shellQuote(input) + " && tmux paste-buffer -t " + shellQuote(sessionName)
	if enter {
		command += " && tmux send-keys -t " + shellQuote(sessionName) + " Enter"
	}
	_, err = run(ctx, sandbox, command, time.Minute)
	return err
}

// SessionRuntimeInterrupt sends Ctrl-C to the isolated agent.
func (p *Provider) SessionRuntimeInterrupt(ctx context.Context, sandboxID string) error {
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return err
	}
	_, err = run(ctx, sandbox, "tmux send-keys -t "+shellQuote(sessionName)+" C-c", time.Minute)
	return err
}

// SessionRuntimeResize keeps the detached tmux window aligned with the desktop
// terminal grid. Without an explicit size, tmux retains its default 80x24 pane
// and full-screen agent interfaces wrap before their captured output is sent.
func (p *Provider) SessionRuntimeResize(ctx context.Context, sandboxID string, rows, cols uint16) error {
	sandbox, err := p.client.Get(ctx, strings.TrimSpace(sandboxID))
	if err != nil {
		return err
	}
	command := "tmux set-option -t " + shellQuote(sessionName) + " window-size manual" +
		" && tmux resize-window -t " + shellQuote(sessionName) + " -x " + strconv.Itoa(int(cols)) + " -y " + strconv.Itoa(int(rows))
	_, err = run(ctx, sandbox, command, time.Minute)
	return err
}

func sandboxProvidedCommand(argument string, harness harnesscatalog.Spec) (string, bool) {
	if filepath.IsAbs(argument) && filepath.Base(argument) == harness.Executable {
		return harness.Executable, true
	}
	return "", false
}

func sandboxClaudeConfig(root string) ([]byte, error) {
	value, err := json.Marshal(map[string]any{
		"hasCompletedOnboarding": true,
		"projects": map[string]any{
			root: map[string]any{"hasTrustDialogAccepted": true},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("encode sandbox Claude config: %w", err)
	}
	return append(value, '\n'), nil
}

func sandboxPATH(home, harnessBinary string) string {
	parts := []string{filepath.Join(home, "bin"), filepath.Dir(harnessBinary), "/usr/local/bin", "/usr/bin", "/bin"}
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if !slices.Contains(result, part) {
			result = append(result, part)
		}
	}
	return strings.Join(result, ":")
}

func replaceRuntimePaths(value string, replacements map[string]string) string {
	for source, destination := range replacements {
		if source != "" {
			value = strings.ReplaceAll(value, source, destination)
		}
	}
	return value
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

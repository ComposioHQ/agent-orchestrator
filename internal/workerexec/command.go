package workerexec

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

var ErrUnsupportedPolicy = errors.New("coding-agent policy cannot be enforced safely")

type Command struct {
	Path    string
	Args    []string
	Dir     string
	Env     map[string]string
	Cleanup func()
}

type CommandBuilder interface {
	Build(context.Context, worker.Turn, worker.CredentialResponse, string) (Command, error)
}

// HarnessBuilder keeps command construction behind a small boundary until the
// public backend exposes a reusable agentruntime package.
type HarnessBuilder struct {
	Binaries map[string]string
	DataDir  string
}

func (b HarnessBuilder) Build(
	_ context.Context,
	turn worker.Turn,
	credential worker.CredentialResponse,
	workspace string,
) (Command, error) {
	if credential.Provider != turn.Harness || strings.TrimSpace(credential.Secret) == "" {
		return Command{}, errors.New("credential does not match the selected harness")
	}
	if turn.Mode != "read-only" && turn.Mode != "standard" && turn.Mode != "trusted" {
		return Command{}, fmt.Errorf("%w: unknown session mode %q", ErrUnsupportedPolicy, turn.Mode)
	}
	command := Command{
		Path: b.binary(turn.Harness),
		Dir:  workspace,
		Env:  map[string]string{},
	}
	var err error
	switch turn.Harness {
	case "claude-code":
		command.Args, err = claudeArgs(turn)
		if credential.CredentialType == "api_key" {
			command.Env["ANTHROPIC_API_KEY"] = credential.Secret
		} else if credential.CredentialType == "oauth_token" {
			command.Env["CLAUDE_CODE_OAUTH_TOKEN"] = credential.Secret
		} else {
			err = errors.New("unsupported Claude Code credential type")
		}
	case "codex":
		command.Args, err = codexArgs(turn)
		if err == nil {
			switch credential.CredentialType {
			case "api_key":
				command.Env["OPENAI_API_KEY"] = credential.Secret
			case "access_token":
				err = b.writeCodexAuth(&command, credential.Secret)
			default:
				err = errors.New("unsupported Codex credential type")
			}
		}
	case "cursor":
		command.Args, err = cursorArgs(turn)
		if credential.CredentialType == "api_key" {
			command.Env["CURSOR_API_KEY"] = credential.Secret
		} else {
			err = errors.New("unsupported Cursor credential type")
		}
	default:
		err = fmt.Errorf("unsupported coding-agent harness %q", turn.Harness)
	}
	if err != nil {
		if command.Cleanup != nil {
			command.Cleanup()
		}
		return Command{}, err
	}
	return command, nil
}

func (b HarnessBuilder) binary(harness string) string {
	if binary := strings.TrimSpace(b.Binaries[harness]); binary != "" {
		return binary
	}
	switch harness {
	case "claude-code":
		return "claude"
	case "codex":
		return "codex"
	case "cursor":
		return "cursor-agent"
	default:
		return harness
	}
}

func claudeArgs(turn worker.Turn) ([]string, error) {
	args := []string{"--print", "--output-format", "stream-json"}
	switch turn.Mode {
	case "read-only":
		args = append(args, "--permission-mode", "plan")
	case "standard":
		args = append(args, "--permission-mode", "acceptEdits")
	case "trusted":
		args = append(args, "--dangerously-skip-permissions")
	}
	if len(turn.DeniedCommands) > 0 {
		deny := make([]string, 0, len(turn.DeniedCommands))
		for _, pattern := range turn.DeniedCommands {
			pattern = strings.TrimSpace(pattern)
			if pattern == "" {
				return nil, fmt.Errorf("%w: empty denied command", ErrUnsupportedPolicy)
			}
			deny = append(deny, "Bash("+pattern+")")
		}
		settings, err := json.Marshal(map[string]any{
			"permissions": map[string]any{"deny": deny},
		})
		if err != nil {
			return nil, err
		}
		args = append(args, "--settings", string(settings))
	}
	if turn.AgentSessionID != "" {
		args = append(args, "--resume", turn.AgentSessionID)
	}
	return append(args, turn.Prompt), nil
}

func codexArgs(turn worker.Turn) ([]string, error) {
	if len(turn.DeniedCommands) > 0 {
		return nil, fmt.Errorf("%w: Codex has no exact denied-command primitive", ErrUnsupportedPolicy)
	}
	args := []string{"exec", "--json", "--skip-git-repo-check"}
	switch turn.Mode {
	case "read-only":
		args = append(args, "--sandbox", "read-only")
	case "standard":
		args = append(args, "--sandbox", "workspace-write")
	case "trusted":
		args = append(args, "--sandbox", "danger-full-access")
	}
	if turn.AgentSessionID != "" {
		args = append(args, "resume", turn.AgentSessionID)
	}
	return append(args, turn.Prompt), nil
}

func cursorArgs(turn worker.Turn) ([]string, error) {
	if len(turn.DeniedCommands) > 0 {
		return nil, fmt.Errorf("%w: Cursor has no exact denied-command primitive", ErrUnsupportedPolicy)
	}
	if turn.Mode == "read-only" {
		return nil, fmt.Errorf("%w: Cursor has no verified read-only mode", ErrUnsupportedPolicy)
	}
	args := []string{"agent", "--print", "--output-format", "stream-json"}
	if turn.Mode == "trusted" {
		args = append(args, "--force")
	}
	if turn.AgentSessionID != "" {
		args = append(args, "--resume", turn.AgentSessionID)
	}
	return append(args, turn.Prompt), nil
}

func (b HarnessBuilder) writeCodexAuth(command *Command, accessToken string) error {
	parent := strings.TrimSpace(b.DataDir)
	if parent == "" {
		parent = os.TempDir()
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create worker data directory: %w", err)
	}
	home, err := os.MkdirTemp(parent, "codex-")
	if err != nil {
		return fmt.Errorf("create Codex home: %w", err)
	}
	command.Cleanup = func() { _ = os.RemoveAll(home) }
	encoded, err := json.Marshal(map[string]any{
		"tokens": map[string]string{"access_token": accessToken},
	})
	if err != nil {
		command.Cleanup()
		return err
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), encoded, 0o600); err != nil {
		command.Cleanup()
		return fmt.Errorf("write Codex credential: %w", err)
	}
	command.Env["CODEX_HOME"] = home
	return nil
}

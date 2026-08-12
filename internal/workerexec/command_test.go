package workerexec

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

func TestHarnessBuilderBuildsSupportedCommandsWithoutSecretArgv(t *testing.T) {
	tests := []struct {
		name           string
		turn           worker.Turn
		credentialType string
		wantBinary     string
		wantEnv        string
		wantArgs       []string
	}{
		{
			name: "claude",
			turn: worker.Turn{
				Harness: "claude-code", Mode: "read-only", Prompt: "fix it",
				DeniedCommands: []string{"git push:*"},
			},
			credentialType: "oauth_token",
			wantBinary:     "fake-claude",
			wantEnv:        "CLAUDE_CODE_OAUTH_TOKEN",
			wantArgs:       []string{"--permission-mode", "plan", "--settings"},
		},
		{
			name:           "codex",
			turn:           worker.Turn{Harness: "codex", Mode: "standard", Prompt: "fix it"},
			credentialType: "api_key",
			wantBinary:     "fake-codex",
			wantEnv:        "OPENAI_API_KEY",
			wantArgs:       []string{"--sandbox", "workspace-write"},
		},
		{
			name:           "cursor",
			turn:           worker.Turn{Harness: "cursor", Mode: "trusted", Prompt: "fix it"},
			credentialType: "api_key",
			wantBinary:     "fake-cursor",
			wantEnv:        "CURSOR_API_KEY",
			wantArgs:       []string{"--force"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			builder := HarnessBuilder{Binaries: map[string]string{
				test.turn.Harness: test.wantBinary,
			}}
			command, err := builder.Build(
				context.Background(),
				test.turn,
				worker.CredentialResponse{
					Provider:       test.turn.Harness,
					CredentialType: test.credentialType,
					Secret:         "top-secret",
				},
				t.TempDir(),
			)
			if err != nil {
				t.Fatal(err)
			}
			if command.Cleanup != nil {
				defer command.Cleanup()
			}
			if command.Path != test.wantBinary || command.Env[test.wantEnv] != "top-secret" {
				t.Fatalf("command = %#v", command)
			}
			if strings.Contains(strings.Join(command.Args, " "), "top-secret") {
				t.Fatal("credential leaked into command arguments")
			}
			for _, want := range test.wantArgs {
				if !slices.Contains(command.Args, want) {
					t.Fatalf("args %q do not contain %q", command.Args, want)
				}
			}
		})
	}
}

func TestHarnessBuilderWritesCodexAccessTokenConfig(t *testing.T) {
	builder := HarnessBuilder{DataDir: t.TempDir()}
	command, err := builder.Build(
		context.Background(),
		worker.Turn{Harness: "codex", Mode: "standard", Prompt: "fix it"},
		worker.CredentialResponse{
			Provider:       "codex",
			CredentialType: "access_token",
			Secret:         "access-secret",
		},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer command.Cleanup()
	authPath := filepath.Join(command.Env["CODEX_HOME"], "auth.json")
	info, err := os.Stat(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("auth.json mode = %o", info.Mode().Perm())
	}
	content, err := os.ReadFile(authPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "access-secret") {
		t.Fatalf("auth.json = %s", content)
	}
}

func TestHarnessBuilderFailsClosedForUnsupportedPolicy(t *testing.T) {
	tests := []worker.Turn{
		{Harness: "codex", Mode: "standard", Prompt: "fix", DeniedCommands: []string{"rm:*"}},
		{Harness: "cursor", Mode: "read-only", Prompt: "inspect"},
		{Harness: "cursor", Mode: "standard", Prompt: "fix", DeniedCommands: []string{"git push:*"}},
	}
	for _, turn := range tests {
		_, err := (HarnessBuilder{}).Build(
			context.Background(),
			turn,
			worker.CredentialResponse{
				Provider: turn.Harness, CredentialType: "api_key", Secret: "secret",
			},
			t.TempDir(),
		)
		if !errors.Is(err, ErrUnsupportedPolicy) {
			t.Fatalf("%s policy error = %v", turn.Harness, err)
		}
	}
}

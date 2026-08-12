package workerexec

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/aoagents/agent-orchestrator/backend/pkg/agentruntime"
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
			wantEnv:        "CODEX_HOME",
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
			}, DataDir: t.TempDir(), CodexLogin: successfulCodexLogin}
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
			envValue := command.Env[test.wantEnv]
			if command.Path != test.wantBinary || envValue == "" ||
				(test.turn.Harness != "codex" && envValue != "top-secret") {
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

func TestHarnessBuilderLogsCodexIntoIsolatedProfile(t *testing.T) {
	for _, credentialType := range []string{"api_key", "access_token"} {
		t.Run(credentialType, func(t *testing.T) {
			dataDir := t.TempDir()
			var gotBinary, gotHome, gotType, gotSecret string
			builder := HarnessBuilder{
				Binaries: map[string]string{"codex": "fake-codex"},
				DataDir:  dataDir,
				CodexLogin: func(binary, home, credentialType, secret string) error {
					gotBinary, gotHome = binary, home
					gotType, gotSecret = credentialType, secret
					return nil
				},
			}
			command, err := builder.Build(
				context.Background(),
				worker.Turn{Harness: "codex", Mode: "standard", Prompt: "fix it"},
				worker.CredentialResponse{
					Provider:       "codex",
					CredentialType: credentialType,
					Secret:         "access-secret",
				},
				t.TempDir(),
			)
			if err != nil {
				t.Fatal(err)
			}
			wantHome := filepath.Join(dataDir, "codex")
			if gotBinary != "fake-codex" || gotHome != wantHome ||
				gotType != credentialType || gotSecret != "access-secret" {
				t.Fatalf(
					"login = binary %q home %q type %q secret %q",
					gotBinary, gotHome, gotType, gotSecret,
				)
			}
			if command.Env["CODEX_HOME"] != wantHome {
				t.Fatalf("CODEX_HOME = %q, want %q", command.Env["CODEX_HOME"], wantHome)
			}
			if strings.Contains(strings.Join(command.Args, " "), "access-secret") {
				t.Fatal("Codex secret leaked into argv")
			}
		})
	}
}

func TestHarnessBuilderBuildsInteractiveAgentWithoutHeadlessFlags(t *testing.T) {
	command, err := (HarnessBuilder{
		Binaries: map[string]string{"claude-code": "fake-claude"},
		DataDir:  t.TempDir(),
	}).BuildInteractive(
		worker.LaunchContext{
			SessionID: "session-1",
			Harness:   "claude-code",
			Prompt:    "fix it",
			Mode:      "trusted",
		},
		worker.CredentialResponse{
			Provider:       "claude-code",
			CredentialType: "oauth_token",
			Secret:         "top-secret",
		},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.Args, " ")
	if strings.Contains(joined, "--print") ||
		strings.Contains(joined, "--output-format") {
		t.Fatalf("interactive args contain headless flags: %q", command.Args)
	}
	if !strings.Contains(joined, "--permission-mode bypassPermissions") ||
		command.Args[len(command.Args)-1] != "fix it" {
		t.Fatalf("interactive args = %q", command.Args)
	}
	if command.Env["CLAUDE_CODE_OAUTH_TOKEN"] != "top-secret" ||
		strings.Contains(joined, "top-secret") {
		t.Fatal("interactive credential was not isolated to the environment")
	}
}

func TestHarnessBuilderResumesInteractiveAgentWithoutReplayingPrompt(t *testing.T) {
	dataDir := t.TempDir()
	command, err := (HarnessBuilder{DataDir: dataDir}).BuildInteractive(
		worker.LaunchContext{
			SessionID:      "session-1",
			ProjectID:      "project-1",
			Kind:           "worker",
			Harness:        "claude-code",
			Prompt:         "do not replay this prompt",
			AgentSessionID: "native-session-1",
			Mode:           "trusted",
		},
		worker.CredentialResponse{
			Provider:       "claude-code",
			CredentialType: "oauth_token",
			Secret:         "top-secret",
		},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.Args, " ")
	if !strings.Contains(joined, "--resume native-session-1") {
		t.Fatalf("restore args = %q", command.Args)
	}
	if strings.Contains(joined, "do not replay this prompt") {
		t.Fatalf("restore replayed the original prompt: %q", command.Args)
	}
}

func TestHarnessBuilderFindsPersistedClaudeConversationAfterWorkerReplacement(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	sessionID := "session-legacy"
	identity := agentruntime.ClaudeSessionID(sessionID)
	projectDir := filepath.Join(configDir, "projects", "-workspace-repository")
	if err := os.MkdirAll(projectDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(projectDir, identity+".jsonl"),
		[]byte("{}\n"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	command, err := (HarnessBuilder{DataDir: t.TempDir()}).BuildInteractive(
		worker.LaunchContext{
			SessionID: sessionID,
			ProjectID: "project-1",
			Kind:      "worker",
			Harness:   "claude-code",
			Prompt:    "original prompt",
			Mode:      "trusted",
		},
		worker.CredentialResponse{
			Provider:       "claude-code",
			CredentialType: "oauth_token",
			Secret:         "top-secret",
		},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.Args, " ")
	if !strings.Contains(joined, "--resume "+identity) ||
		strings.Contains(joined, "original prompt") {
		t.Fatalf("replacement args = %q", command.Args)
	}
}

func TestHarnessBuilderRejectsInteractiveCommandDenyRules(t *testing.T) {
	for _, launch := range []worker.LaunchContext{
		{
			SessionID: "session-1",
			Harness:   "claude-code",
			Mode:      "read-only",
		},
		{
			SessionID:      "session-1",
			Harness:        "claude-code",
			Mode:           "trusted",
			DeniedCommands: []string{"git push:*"},
		},
	} {
		_, err := (HarnessBuilder{}).BuildInteractive(
			launch,
			worker.CredentialResponse{
				Provider:       "claude-code",
				CredentialType: "api_key",
				Secret:         "secret",
			},
			t.TempDir(),
		)
		if !errors.Is(err, ErrUnsupportedPolicy) {
			t.Fatalf("interactive policy error = %v", err)
		}
	}
}

func TestHarnessBuilderTeachesOrchestratorsControlPlaneCommands(t *testing.T) {
	command, err := (HarnessBuilder{
		Binaries: map[string]string{"claude-code": "fake-claude"},
		DataDir:  t.TempDir(),
	}).BuildInteractive(
		worker.LaunchContext{
			SessionID: "session-1",
			Kind:      "orchestrator",
			Harness:   "claude-code",
			Mode:      "standard",
		},
		worker.CredentialResponse{
			Provider:       "claude-code",
			CredentialType: "api_key",
			Secret:         "secret",
		},
		t.TempDir(),
	)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.Args, " ")
	if !strings.Contains(joined, "--append-system-prompt") ||
		!strings.Contains(joined, "ao spawn") ||
		!strings.Contains(joined, "control plane") {
		t.Fatalf("orchestrator args do not contain AO guidance: %q", command.Args)
	}
}

func TestHarnessBuilderLaunchesTrustedAgentsWithPromptInArgv(t *testing.T) {
	tests := []struct {
		harness       string
		credential    string
		permissionArg string
	}{
		{harness: "claude-code", credential: "oauth_token", permissionArg: "bypassPermissions"},
		{harness: "codex", credential: "api_key", permissionArg: "--dangerously-bypass-approvals-and-sandbox"},
		{harness: "cursor", credential: "api_key", permissionArg: "--yolo"},
	}
	for _, test := range tests {
		t.Run(test.harness, func(t *testing.T) {
			command, err := (HarnessBuilder{
				Binaries:   map[string]string{test.harness: "fake-" + test.harness},
				DataDir:    t.TempDir(),
				CodexLogin: successfulCodexLogin,
			}).BuildInteractive(
				worker.LaunchContext{
					SessionID: "session-1",
					Harness:   test.harness,
					Prompt:    "start this task immediately",
					Mode:      "trusted",
				},
				worker.CredentialResponse{
					Provider:       test.harness,
					CredentialType: test.credential,
					Secret:         "secret",
				},
				t.TempDir(),
			)
			if err != nil {
				t.Fatal(err)
			}
			joined := strings.Join(command.Args, " ")
			if !strings.Contains(joined, test.permissionArg) {
				t.Fatalf("interactive args %q do not contain %q", command.Args, test.permissionArg)
			}
			if test.harness == "cursor" && !slices.Contains(command.Args, "--trust") {
				t.Fatalf("Cursor args do not trust the workspace: %q", command.Args)
			}
			count := 0
			for _, arg := range command.Args {
				if arg == "start this task immediately" {
					count++
				}
			}
			if count != 1 {
				t.Fatalf("prompt occurs %d times in args %q", count, command.Args)
			}
		})
	}
}

func successfulCodexLogin(_, _, _, _ string) error { return nil }

func TestHarnessBuilderPreconfiguresClaudeOnboarding(t *testing.T) {
	dataDir := t.TempDir()
	workspace := t.TempDir()
	command, err := (HarnessBuilder{
		Binaries: map[string]string{"claude-code": "fake-claude"},
		DataDir:  dataDir,
	}).BuildInteractive(
		worker.LaunchContext{
			SessionID: "session-1",
			Harness:   "claude-code",
			Prompt:    "fix it",
			Mode:      "trusted",
		},
		worker.CredentialResponse{
			Provider:       "claude-code",
			CredentialType: "oauth_token",
			Secret:         "secret",
		},
		workspace,
	)
	if err != nil {
		t.Fatal(err)
	}
	configDir := filepath.Join(dataDir, "claude")
	if command.Env["CLAUDE_CONFIG_DIR"] != configDir {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q, want %q", command.Env["CLAUDE_CONFIG_DIR"], configDir)
	}
	root := readJSONObject(t, filepath.Join(configDir, ".claude.json"))
	if root["hasCompletedOnboarding"] != true || root["theme"] != "dark" {
		t.Fatalf("Claude root config = %#v", root)
	}
	projects, _ := root["projects"].(map[string]any)
	project, _ := projects[workspace].(map[string]any)
	if project["hasTrustDialogAccepted"] != true {
		t.Fatalf("Claude project trust = %#v", projects)
	}
	settings := readJSONObject(t, filepath.Join(configDir, "settings.json"))
	permissions, _ := settings["permissions"].(map[string]any)
	if settings["skipDangerousModePermissionPrompt"] != true ||
		permissions["defaultMode"] != "bypassPermissions" {
		t.Fatalf("Claude settings = %#v", settings)
	}
	localSettings := readJSONObject(
		t, filepath.Join(workspace, ".claude", "settings.local.json"),
	)
	hooks, _ := localSettings["hooks"].(map[string]any)
	if len(hooks) != len(claudeActivityHooks) {
		t.Fatalf("Claude workspace hooks = %#v", hooks)
	}
}

func readJSONObject(t *testing.T, path string) map[string]any {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := json.Unmarshal(contents, &result); err != nil {
		t.Fatal(err)
	}
	return result
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

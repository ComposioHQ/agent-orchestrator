package workerexec

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
)

func TestBuildInteractiveRestoresClaudeConversationFromDurableConfig(t *testing.T) {
	configDir := filepath.Join(t.TempDir(), "claude")
	identity := "99a68dd6-2ad8-4fd8-9ea7-d833ceb2914e"
	conversation := filepath.Join(configDir, "projects", "repository", identity+".jsonl")
	if err := os.MkdirAll(filepath.Dir(conversation), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(conversation, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	command, err := (HarnessBuilder{}).BuildInteractive(worker.LaunchContext{
		SessionID: "session-1", Harness: "claude-code", AgentSessionID: identity,
		Mode: "standard",
	}, worker.CredentialResponse{
		Provider: "claude-code", CredentialType: "api_key", Secret: "secret",
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !containsAdjacent(command.Args, "--resume", identity) {
		t.Fatalf("restore args missing from %#v", command.Args)
	}
	if slices.Contains(command.Args, "--session-id") {
		t.Fatalf("fresh-launch identity present in restore command %#v", command.Args)
	}
	if command.Env["CLAUDE_CONFIG_DIR"] != configDir {
		t.Errorf("CLAUDE_CONFIG_DIR = %q", command.Env["CLAUDE_CONFIG_DIR"])
	}
}

func TestBuildInteractiveUsesConfiguredDurableCodexHomeOnRestore(t *testing.T) {
	codexHome := filepath.Join(t.TempDir(), "codex")
	t.Setenv("CODEX_HOME", codexHome)
	loginHome := ""
	builder := HarnessBuilder{CodexLogin: func(_, home, _, _ string) error {
		loginHome = home
		return nil
	}}
	command, err := builder.BuildInteractive(worker.LaunchContext{
		SessionID: "session-1", Harness: "codex", AgentSessionID: "thread-1",
		Mode: "standard",
	}, worker.CredentialResponse{
		Provider: "codex", CredentialType: "api_key", Secret: "secret",
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if loginHome != codexHome || command.Env["CODEX_HOME"] != codexHome {
		t.Fatalf("Codex durable home: login=%q env=%q", loginHome, command.Env["CODEX_HOME"])
	}
	if !slices.Contains(command.Args, "thread-1") || len(command.Args) == 0 || command.Args[0] != "resume" {
		t.Fatalf("unexpected Codex restore args: %#v", command.Args)
	}
}

func containsAdjacent(values []string, first, second string) bool {
	for index := 0; index+1 < len(values); index++ {
		if values[index] == first && values[index+1] == second {
			return true
		}
	}
	return false
}

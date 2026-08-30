package workerexec

import (
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
)

func buildInteractive(t *testing.T, launch worker.LaunchContext) Command {
	t.Helper()
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	credential := worker.CredentialResponse{
		Provider: launch.Harness, CredentialType: "api_key", Secret: "test-secret",
	}
	command, err := HarnessBuilder{DataDir: t.TempDir()}.BuildInteractive(
		launch, credential, t.TempDir(),
	)
	if err != nil {
		t.Fatalf("BuildInteractive: %v", err)
	}
	t.Cleanup(func() {
		if command.Cleanup != nil {
			command.Cleanup()
		}
	})
	return command
}

// systemPromptArg extracts the value following --append-system-prompt, "" when
// the flag is absent.
func systemPromptArg(command Command) string {
	args := append([]string{command.Path}, command.Args...)
	for i, arg := range args {
		if arg == "--append-system-prompt" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func TestBuildInteractiveOrchestratorPrompt(t *testing.T) {
	command := buildInteractive(t, worker.LaunchContext{
		SessionID: "11111111-1111-4111-8111-111111111111",
		Kind:      "orchestrator", Harness: "claude-code", Mode: "trusted",
	})
	prompt := systemPromptArg(command)
	if prompt == "" {
		t.Fatal("orchestrator launch carries no system prompt")
	}
	// Cloud grammar in, desktop grammar out.
	for _, needle := range []string{
		"AO Orchestrator Role",
		"ao spawn --name",
		"ao list",
		"ao kill",
		"skills/using-ao/SKILL.md",
		"coordination-only",
	} {
		if !strings.Contains(prompt, needle) {
			t.Fatalf("orchestrator prompt missing %q", needle)
		}
	}
	for _, forbidden := range []string{"ao session ls", "ao status", "--project"} {
		if strings.Contains(prompt, forbidden) {
			t.Fatalf("orchestrator prompt suggests desktop-only %q", forbidden)
		}
	}
}

func TestBuildInteractiveWorkerPromptWithParent(t *testing.T) {
	command := buildInteractive(t, worker.LaunchContext{
		SessionID: "11111111-1111-4111-8111-111111111111",
		Kind:      "worker", Harness: "claude-code", Mode: "trusted",
		ParentSessionID: "22222222-2222-4222-8222-222222222222",
	})
	prompt := systemPromptArg(command)
	if prompt == "" {
		t.Fatal("worker launch carries no system prompt")
	}
	for _, needle := range []string{
		"AO Worker Role",
		"ao report",
		"$AO_PULL_REQUEST_HELP",
		"$AO_SESSION_BRANCH",
		"ao claim-pr",
		"skills/using-ao/SKILL.md",
	} {
		if !strings.Contains(prompt, needle) {
			t.Fatalf("worker prompt missing %q", needle)
		}
	}
}

func TestBuildInteractiveWorkerPromptWithoutParent(t *testing.T) {
	command := buildInteractive(t, worker.LaunchContext{
		SessionID: "11111111-1111-4111-8111-111111111111",
		Kind:      "worker", Harness: "claude-code", Mode: "trusted",
	})
	prompt := systemPromptArg(command)
	if strings.Contains(prompt, "ao report") {
		t.Fatal("parentless worker prompt must not suggest ao report (scope is stripped)")
	}
	if !strings.Contains(prompt, "no orchestrator is attached") {
		t.Fatal("parentless worker prompt missing the direct-report guidance")
	}
}

func TestBuildInteractiveCursorBuildsWithoutPrompt(t *testing.T) {
	// The cursor launch builder discards SystemPrompt (known limitation); the
	// build must still succeed so the session gets its terminal and on-disk
	// skill.
	command := buildInteractive(t, worker.LaunchContext{
		SessionID: "11111111-1111-4111-8111-111111111111",
		Kind:      "worker", Harness: "cursor", Mode: "trusted",
	})
	if prompt := systemPromptArg(command); prompt != "" {
		t.Fatalf("cursor unexpectedly carries a system prompt flag: %q", prompt)
	}
}

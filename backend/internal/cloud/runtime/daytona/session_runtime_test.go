package daytona

import (
	"encoding/json"
	"testing"
)

func TestEnvironmentKeyPattern(t *testing.T) {
	t.Parallel()
	for _, key := range []string{"HOME", "AO_SESSION_ID", "_PRIVATE", "value9"} {
		if !environmentKeyPattern.MatchString(key) {
			t.Fatalf("valid environment key %q was rejected", key)
		}
	}
	for _, key := range []string{"", "9VALUE", "BAD KEY", "BAD-NAME", "NAME=value", "$(touch /tmp/bad)"} {
		if environmentKeyPattern.MatchString(key) {
			t.Fatalf("invalid environment key %q was accepted", key)
		}
	}
}

func TestSandboxProvidedCommandMapsClaudeToPathLookup(t *testing.T) {
	got, ok := sandboxProvidedCommand("/usr/local/share/nvm/current/bin/claude")
	if !ok || got != "claude" {
		t.Fatalf("sandboxProvidedCommand() = %q, %v, want claude, true", got, ok)
	}
	if got, ok = sandboxProvidedCommand("/tmp/prompt.txt"); ok || got != "" {
		t.Fatalf("sandboxProvidedCommand(prompt) = %q, %v, want empty, false", got, ok)
	}
}

func TestSandboxPATHIncludesResolvedClaudeDirectory(t *testing.T) {
	got := sandboxPATH("/home/daytona", "/usr/local/share/nvm/current/bin/claude")
	want := "/home/daytona/bin:/usr/local/share/nvm/current/bin:/usr/local/bin:/usr/bin:/bin"
	if got != want {
		t.Fatalf("sandboxPATH() = %q, want %q", got, want)
	}
}

func TestSandboxClaudeConfigTrustsClonedWorkspace(t *testing.T) {
	value, err := sandboxClaudeConfig("/home/daytona/workspace")
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		HasCompletedOnboarding bool `json:"hasCompletedOnboarding"`
		Projects               map[string]struct {
			HasTrustDialogAccepted bool `json:"hasTrustDialogAccepted"`
		} `json:"projects"`
	}
	if err = json.Unmarshal(value, &config); err != nil {
		t.Fatal(err)
	}
	if !config.HasCompletedOnboarding || !config.Projects["/home/daytona/workspace"].HasTrustDialogAccepted {
		t.Fatalf("sandbox Claude config = %#v", config)
	}
}

package daytona

import "testing"

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

package workerexec

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClaudeActivityHooksAreInstalledWithoutReplacingSettings(t *testing.T) {
	settings := map[string]any{
		"theme": "dark",
		"hooks": map[string]any{
			"Stop": []any{map[string]any{"hooks": []any{
				map[string]any{"type": "command", "command": "user-stop-hook"},
			}}},
		},
	}

	installClaudeActivityHooks(settings)
	installClaudeActivityHooks(settings)

	encoded, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, "user-stop-hook") {
		t.Fatal("existing Claude hook was removed")
	}
	hooks := settings["hooks"].(map[string]any)
	for _, hook := range claudeActivityHooks {
		command := hookCommand("claude-code", hook.event)
		if countHookCommand(hooks[hook.nativeEvent], command) != 1 {
			t.Fatalf("hook command %q was not installed exactly once: %s", command, text)
		}
	}
}

func TestGlobalClaudeActivityHookCleanupPreservesUserHooks(t *testing.T) {
	settings := map[string]any{
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{"hooks": []any{
					map[string]any{"type": "command", "command": "user-stop-hook"},
				}},
				map[string]any{"hooks": []any{
					map[string]any{
						"type":    "command",
						"command": hookCommand("claude-code", "stop"),
					},
				}},
			},
		},
	}

	removeGlobalClaudeActivityHooks(settings)

	encoded, err := json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, "user-stop-hook") ||
		strings.Contains(text, hookCommand("claude-code", "stop")) {
		t.Fatalf("cleaned settings = %s", text)
	}
}

func TestCursorActivityHooksAreInstalledWithoutReplacingHooks(t *testing.T) {
	workspace := t.TempDir()
	path := filepath.Join(workspace, ".cursor", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		path,
		[]byte(`{"version":1,"hooks":{"stop":[{"command":"user-stop-hook"}]}}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}

	if err := installCursorActivityHooks(workspace); err != nil {
		t.Fatal(err)
	}
	if err := installCursorActivityHooks(workspace); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	if !strings.Contains(text, "user-stop-hook") {
		t.Fatal("existing Cursor hook was removed")
	}
	var root map[string]any
	if err := json.Unmarshal(contents, &root); err != nil {
		t.Fatal(err)
	}
	hooks := root["hooks"].(map[string]any)
	for _, hook := range cursorActivityHooks {
		command := hookCommand("cursor", hook.event)
		if countHookCommand(hooks[hook.nativeEvent], command) != 1 {
			t.Fatalf("hook command %q was not installed exactly once: %s", command, text)
		}
	}
}

func countHookCommand(value any, command string) int {
	count := 0
	switch typed := value.(type) {
	case map[string]any:
		if typed["command"] == command {
			count++
		}
		for _, child := range typed {
			count += countHookCommand(child, command)
		}
	case []any:
		for _, child := range typed {
			count += countHookCommand(child, command)
		}
	}
	return count
}

func TestCodexActivityHooksRideTheLaunchCommand(t *testing.T) {
	args := codexActivityHookArgs()
	for _, hook := range codexActivityHooks {
		command := hookCommand("codex", hook.event)
		found := false
		for _, arg := range args {
			if strings.Contains(arg, command) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("Codex hook command %q missing from %#v", command, args)
		}
	}
}

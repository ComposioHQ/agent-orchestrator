package deveco

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestGetAgentHooksUsesDevEcoPathsAndWindowsSafeSpawn(t *testing.T) {
	workspace := t.TempDir()
	plugin := New()
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatal(err)
	}

	pluginPath := filepath.Join(workspace, ".deveco", "plugins", "ao-activity.ts")
	if got := devecoPluginPath(workspace); got != pluginPath {
		t.Fatalf("plugin path = %q, want %q", got, pluginPath)
	}
	bodyBytes, err := os.ReadFile(pluginPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(bodyBytes)
	for _, marker := range []string{
		devecoPluginSentinel,
		`Bun.which("ao")`,
		`Bun.spawnSync([ao, "hooks", "deveco", hookName]`,
		"session.created",
		"message.updated",
		"message.part.updated",
		"session.status",
		`case "permission.asked":`,
		`case "question.asked":`,
		`"tool.execute.before":`,
		`"tool.execute.after":`,
	} {
		if !strings.Contains(body, marker) {
			t.Fatalf("plugin missing %q", marker)
		}
	}
	for _, forbidden := range []string{`["sh", "-c"`, `command -v`, `exec ao hooks`, `cmd.exe`, `powershell.exe`} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("plugin contains shell-only command %q", forbidden)
		}
	}
	for _, event := range devecoManagedEvents {
		if !strings.Contains(body, `"`+event+`"`) {
			t.Fatalf("plugin missing AO event %q", event)
		}
	}

	skill := filepath.Join(workspace, ".deveco", "skills", "using-ao", "SKILL.md")
	if _, err := os.Stat(skill); err != nil {
		t.Fatalf("using-ao skill not installed in .deveco: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".opencode")); !os.IsNotExist(err) {
		t.Fatalf("DevEco hook install must not create .opencode, err=%v", err)
	}
	installed, err := plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil || !installed {
		t.Fatalf("AreHooksInstalled = (%v, %v)", installed, err)
	}
	if err := plugin.UninstallHooks(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	installed, err = plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil || installed {
		t.Fatalf("AreHooksInstalled after uninstall = (%v, %v)", installed, err)
	}
}

func TestGetAgentHooksPreservesForeignPlugin(t *testing.T) {
	workspace := t.TempDir()
	path := devecoPluginPath(workspace)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := []byte("export const userPlugin = async () => ({})\n")
	if err := os.WriteFile(path, foreign, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := New().GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err == nil {
		t.Fatal("expected refusal to overwrite foreign plugin")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(foreign) {
		t.Fatalf("foreign plugin changed: %q, %v", got, err)
	}
}

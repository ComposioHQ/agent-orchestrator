package agy

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	plugin := New()
	manifest := plugin.Manifest()
	if manifest.ID != "agy" {
		t.Fatalf("manifest id = %q, want agy", manifest.ID)
	}
}

func TestGetLaunchCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "fix this",
		WorkspacePath: "/tmp/ws",
		Config:        ports.AgentConfig{Model: "gemini-3-pro"},
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"agy",
		"--add-dir", "/tmp/ws",
		"--dangerously-skip-permissions",
		"--model", "gemini-3-pro",
		"--prompt-interactive", "fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetLaunchCommandNoModel(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Permissions:   ports.PermissionModeBypassPermissions,
		Prompt:        "fix this",
		WorkspacePath: "/tmp/ws",
	})
	if err != nil {
		t.Fatal(err)
	}

	want := []string{
		"agy",
		"--add-dir", "/tmp/ws",
		"--dangerously-skip-permissions",
		"--prompt-interactive", "fix this",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetPromptDeliveryStrategy(t *testing.T) {
	plugin := &Plugin{}
	got, err := plugin.GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want in_command", got)
	}
}

func TestGetRestoreCommand(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Permissions: ports.PermissionModeBypassPermissions,
		Config:      ports.AgentConfig{Model: "gemini-3-flash"},
		Session: ports.SessionRef{
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "native-id-123"},
			WorkspacePath: "/tmp/ws",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected ok=true")
	}

	want := []string{
		"agy",
		"--add-dir", "/tmp/ws",
		"--dangerously-skip-permissions",
		"--model", "gemini-3-flash",
		"--conversation", "native-id-123",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("unexpected command\nwant: %#v\n got: %#v", want, cmd)
	}
}

func TestGetRestoreCommandNoSessionID(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}
	_, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("expected ok=false when agentSessionId is missing")
	}
}

func TestSessionInfo(t *testing.T) {
	plugin := &Plugin{}
	info, ok, err := plugin.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "native-id-123",
			"title":                         "My Title",
			"summary":                       "My Summary",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected ok=true")
	}
	if info.AgentSessionID != "native-id-123" || info.Title != "My Title" || info.Summary != "My Summary" {
		t.Fatalf("unexpected SessionInfo: %#v", info)
	}
}

func TestHooksLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	plugin := &Plugin{}
	cfg := ports.WorkspaceHookConfig{WorkspacePath: tmpDir}

	hooksJSONPath := filepath.Join(tmpDir, ".agents", "hooks.json")
	if err := os.MkdirAll(filepath.Dir(hooksJSONPath), 0o750); err != nil {
		t.Fatal(err)
	}
	seed := `{
  "user-hook": {
    "Stop": [{"type":"command","command":"./user-stop.sh"}]
  },
  "agent-orchestrator-chat": {
    "PreInvocation": [{"type":"command","command":"ao agy-chat-hook pre-invocation"}]
  }
}
`
	if err := os.WriteFile(hooksJSONPath, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	installed, err := plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("user/chat hooks must not count as TUI hooks")
	}

	if err := plugin.GetAgentHooks(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	installed, err = plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("expected TUI hooks to be installed")
	}

	data, err := os.ReadFile(hooksJSONPath)
	if err != nil {
		t.Fatal(err)
	}
	var file agyHookFile
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if _, ok := file["user-hook"]; !ok {
		t.Fatal("install removed user hook set")
	}
	if _, ok := file["agent-orchestrator-chat"]; !ok {
		t.Fatal("install removed Agy Chat hook set")
	}

	raw, ok := file[agyManagedHookName]
	if !ok {
		t.Fatalf("missing %q hook set", agyManagedHookName)
	}
	var definition agyHookDefinition
	if err := json.Unmarshal(raw, &definition); err != nil {
		t.Fatal(err)
	}
	if len(definition.PreInvocation) != 1 || definition.PreInvocation[0].Command != "ao hooks agy pre-invocation" {
		t.Fatalf("unexpected PreInvocation hooks: %#v", definition.PreInvocation)
	}
	if len(definition.PostToolUse) != 1 || definition.PostToolUse[0].Matcher != "*" ||
		len(definition.PostToolUse[0].Hooks) != 1 || definition.PostToolUse[0].Hooks[0].Command != "ao hooks agy post-tool-use" {
		t.Fatalf("unexpected PostToolUse hooks: %#v", definition.PostToolUse)
	}
	if len(definition.Stop) != 1 || definition.Stop[0].Command != "ao hooks agy stop" {
		t.Fatalf("unexpected Stop hooks: %#v", definition.Stop)
	}

	if err := plugin.UninstallHooks(context.Background(), tmpDir); err != nil {
		t.Fatal(err)
	}
	installed, err = plugin.AreHooksInstalled(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("expected TUI hooks to be removed")
	}

	data, err = os.ReadFile(hooksJSONPath)
	if err != nil {
		t.Fatal(err)
	}
	file = nil
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	if _, ok := file["user-hook"]; !ok {
		t.Fatal("uninstall removed user hook set")
	}
	if _, ok := file["agent-orchestrator-chat"]; !ok {
		t.Fatal("uninstall removed Agy Chat hook set")
	}
	if _, ok := file[agyManagedHookName]; ok {
		t.Fatal("uninstall left TUI hook set behind")
	}
}

func TestAuthStatus(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "agy"}

	status, err := plugin.AuthStatus(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Errorf("AuthStatus() = %v, want AgentAuthStatusAuthorized", status)
	}
}

func TestGetConfigSpecReportsModelField(t *testing.T) {
	plugin := &Plugin{}

	spec, err := plugin.GetConfigSpec(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []ports.ConfigField{
		{
			Key:         "model",
			Type:        ports.ConfigFieldString,
			Description: "Model override passed to `agy --model` (e.g. gemini-3-pro).",
		},
	}
	if !reflect.DeepEqual(spec.Fields, want) {
		t.Fatalf("config fields\nwant: %#v\n got: %#v", want, spec.Fields)
	}
}

package omp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifest(t *testing.T) {
	m := (&Plugin{}).Manifest()
	if m.ID != "omp" {
		t.Fatalf("ID = %q, want omp", m.ID)
	}
	if m.Name != "OMP" {
		t.Fatalf("Name = %q, want OMP", m.Name)
	}
	hasAgent := false
	for _, c := range m.Capabilities {
		if c == adapters.CapabilityAgent {
			hasAgent = true
		}
	}
	if !hasAgent {
		t.Fatal("missing CapabilityAgent")
	}
}

func TestGetConfigSpecReportsModelField(t *testing.T) {
	spec, err := (&Plugin{}).GetConfigSpec(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	want := []ports.ConfigField{{
		Key:         "model",
		Type:        ports.ConfigFieldString,
		Description: "Model override passed to `omp --model`.",
	}}
	if !reflect.DeepEqual(spec.Fields, want) {
		t.Fatalf("config fields\nwant: %#v\n got: %#v", want, spec.Fields)
	}
}

func TestGetPromptDeliveryStrategyIsInCommand(t *testing.T) {
	got, err := (&Plugin{}).GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want %q", got, ports.PromptDeliveryInCommand)
	}
}

func TestGetLaunchCommandStartsInteractiveTUIWithPrompt(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Prompt: "add a health check",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"omp", "add a health check"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandAppendsSystemPromptAndModel(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPrompt: "follow repo rules",
		Config:       ports.AgentConfig{Model: "  anthropic/claude-sonnet-4  "},
		Prompt:       "implement it",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"omp", "--append-system-prompt", "follow repo rules", "--model", "anthropic/claude-sonnet-4", "implement it"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetLaunchCommandReadsSystemPromptFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "system.md")
	if err := os.WriteFile(file, []byte("file prompt"), 0o600); err != nil {
		t.Fatal(err)
	}

	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		SystemPromptFile: file,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"omp", "--append-system-prompt", "file prompt"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandUsesNativeSessionID(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		SystemPrompt: "restore rules",
		Config:       ports.AgentConfig{Model: "openai/gpt-5-codex"},
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "019e950e-52e0-7411-961b-d380ca7e610f"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	want := []string{"omp", "--append-system-prompt", "restore rules", "--model", "openai/gpt-5-codex", "--resume", "019e950e-52e0-7411-961b-d380ca7e610f"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandWithoutNativeSessionIDReturnsNotOK(t *testing.T) {
	p := &Plugin{resolvedBinary: "omp"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if ok || cmd != nil {
		t.Fatalf("cmd=%#v ok=%v, want nil false", cmd, ok)
	}
}

func TestGetLaunchCommandExplicitlyLoadsManagedExtension(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{resolvedBinary: "omp"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		WorkspacePath: workspace,
		Prompt:        "fix the bug",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"omp", "--extension", filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts"), "fix the bug"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandExplicitlyLoadsManagedExtension(t *testing.T) {
	workspace := t.TempDir()
	p := &Plugin{resolvedBinary: "omp"}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			WorkspacePath: workspace,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: "native-omp-1"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("ok=false, want true")
	}
	want := []string{"omp", "--extension", filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts"), "--resume", "native-omp-1"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetAgentHooksInstallsManagedActivityExtension(t *testing.T) {
	workspace := t.TempDir()
	plugin := &Plugin{resolvedBinary: "omp"}
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatalf("GetAgentHooks err = %v", err)
	}

	extensionPath := filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts")
	data, err := os.ReadFile(extensionPath)
	if err != nil {
		t.Fatalf("read managed extension: %v", err)
	}
	text := string(data)
	for _, want := range []string{
		"agent-orchestrator: managed omp activity extension",
		`pi.on("session_start"`,
		`pi.on("before_agent_start"`,
		`pi.on("session_stop"`,
		`pi.on("session_shutdown"`,
		`"hooks", "omp", hookName`,
		"getSessionId()",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("managed extension missing %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, `pi.on("agent_settled"`) {
		t.Fatal("OMP extension must not listen for Pi-only agent_settled")
	}

	gitignore, err := os.ReadFile(filepath.Join(workspace, ".omp", "extensions", ".gitignore"))
	if err != nil {
		t.Fatalf("read extension .gitignore: %v", err)
	}
	if !strings.Contains(string(gitignore), "/ao-activity.ts") {
		t.Fatalf("extension .gitignore does not ignore AO file:\n%s", gitignore)
	}

	installed, err := plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("AreHooksInstalled after install = false, want true")
	}

	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatalf("second GetAgentHooks err = %v", err)
	}
}

func TestGetAgentHooksRefusesForeignManagedPath(t *testing.T) {
	workspace := t.TempDir()
	extensionPath := filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts")
	if err := os.MkdirAll(filepath.Dir(extensionPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(extensionPath, []byte("export default function userExtension() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := (&Plugin{resolvedBinary: "omp"}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace})
	if err == nil || !strings.Contains(err.Error(), "refusing to overwrite") {
		t.Fatalf("GetAgentHooks err = %v, want foreign-file refusal", err)
	}
}

func TestUninstallHooksRemovesManagedExtension(t *testing.T) {
	workspace := t.TempDir()
	plugin := &Plugin{resolvedBinary: "omp"}
	if err := plugin.GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{WorkspacePath: workspace}); err != nil {
		t.Fatal(err)
	}
	if err := plugin.UninstallHooks(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	installed, err := plugin.AreHooksInstalled(context.Background(), workspace)
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("AreHooksInstalled after uninstall = true, want false")
	}
	if _, err := os.Stat(filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts")); !os.IsNotExist(err) {
		t.Fatalf("managed extension still present after uninstall: %v", err)
	}
}

func TestUninstallHooksPreservesForeignExtension(t *testing.T) {
	workspace := t.TempDir()
	extensionPath := filepath.Join(workspace, ".omp", "extensions", "ao-activity.ts")
	if err := os.MkdirAll(filepath.Dir(extensionPath), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(extensionPath, []byte("export default function userExtension() {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	plugin := &Plugin{resolvedBinary: "omp"}
	if err := plugin.UninstallHooks(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(extensionPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "export default function userExtension() {}\n" {
		t.Fatalf("foreign extension rewritten:\n%s", data)
	}
}

func TestUninstallHooksMissingFileIsNoOp(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "omp"}
	if err := plugin.UninstallHooks(context.Background(), t.TempDir()); err != nil {
		t.Fatalf("uninstall on missing file = %v, want nil", err)
	}
	installed, err := plugin.AreHooksInstalled(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if installed {
		t.Fatal("AreHooksInstalled on empty workspace = true, want false")
	}
}

func TestGetAgentHooksRequiresWorkspacePath(t *testing.T) {
	err := (&Plugin{}).GetAgentHooks(context.Background(), ports.WorkspaceHookConfig{})
	if err == nil || !strings.Contains(err.Error(), "WorkspacePath is required") {
		t.Fatalf("GetAgentHooks err = %v, want WorkspacePath message", err)
	}
}

func TestContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := (&Plugin{}).GetAgentHooks(ctx, ports.WorkspaceHookConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetAgentHooks err = %v, want context.Canceled", err)
	}
	if err := (&Plugin{}).UninstallHooks(ctx, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("UninstallHooks err = %v, want context.Canceled", err)
	}
	if _, err := (&Plugin{}).AreHooksInstalled(ctx, t.TempDir()); !errors.Is(err, context.Canceled) {
		t.Fatalf("AreHooksInstalled err = %v, want context.Canceled", err)
	}
	if _, _, err := (&Plugin{}).GetRestoreCommand(ctx, ports.RestoreConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetRestoreCommand err = %v, want context.Canceled", err)
	}
}

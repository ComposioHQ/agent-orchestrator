package deveco

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencodefamily"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestManifestRegistersIndependentDevEcoAgent(t *testing.T) {
	manifest := New().Manifest()
	if manifest.ID != "deveco" || manifest.Name != "DevEco Code" {
		t.Fatalf("manifest = %#v", manifest)
	}
}

func TestGetLaunchCommandBuildsNativeArgvAndConfig(t *testing.T) {
	plugin := &Plugin{resolvedBinary: `C:\tools\deveco.exe`}
	promptFile := filepath.Join(t.TempDir(), "system.md")
	cmd, err := plugin.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Config:           ports.AgentConfig{Model: "huawei/glm-5.1"},
		Permissions:      ports.PermissionModeBypassPermissions,
		Prompt:           "create test-a.txt & keep this literal",
		SessionID:        "sess/1",
		SystemPrompt:     "follow AO rules",
		SystemPromptFile: promptFile,
		WorkspacePath:    `C:\worktrees\worker-a`,
	})
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(filepath.Dir(promptFile), "deveco.json")
	want := []string{
		"env", "DEVECO_CONFIG=" + configPath, "DEVECO_TRUST=1",
		`C:\tools\deveco.exe`,
		"--dangerously-skip-permissions",
		"--model", "huawei/glm-5.1",
		"--agent", "ao-sess-1",
		"--prompt", "create test-a.txt & keep this literal",
	}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("command\nwant: %#v\n got: %#v", want, cmd)
	}
	for _, forbidden := range []string{"sh", "bash", "cmd.exe", "powershell.exe"} {
		if contains(cmd, forbidden) {
			t.Fatalf("Windows launch command must not invoke %q: %#v", forbidden, cmd)
		}
	}

	var config opencodefamily.InlineConfig
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if got := config.Agent["ao-sess-1"]; got.Mode != "primary" || got.Prompt != "follow AO rules" {
		t.Fatalf("agent config = %#v", got)
	}
	if strings.Contains(configPath, ".opencode") {
		t.Fatalf("DevEco config leaked into OpenCode path: %s", configPath)
	}
}

func TestGetLaunchCommandUsesCurrentPromptFlag(t *testing.T) {
	cmd, err := (&Plugin{resolvedBinary: "deveco"}).GetLaunchCommand(context.Background(), ports.LaunchConfig{Prompt: "-fix this"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"env", "DEVECO_TRUST=1", "deveco", "--prompt", "-fix this"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
	strategy, err := New().GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil || strategy != ports.PromptDeliveryInCommand {
		t.Fatalf("prompt strategy = (%q, %v)", strategy, err)
	}
}

func TestGetRestoreCommandUsesCapturedSession(t *testing.T) {
	plugin := &Plugin{resolvedBinary: "deveco"}
	cmd, ok, err := plugin.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			ID:       "worker-a",
			Metadata: map[string]string{devecoAgentSessionIDMetadata: "ses_native_a"},
		},
	})
	if err != nil || !ok {
		t.Fatalf("restore = (%#v, %v, %v)", cmd, ok, err)
	}
	want := []string{"env", "DEVECO_TRUST=1", "deveco", "--session", "ses_native_a"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestGetRestoreCommandWithoutNativeSessionFallsBack(t *testing.T) {
	cmd, ok, err := (&Plugin{resolvedBinary: "deveco"}).GetRestoreCommand(context.Background(), ports.RestoreConfig{})
	if err != nil || ok || cmd != nil {
		t.Fatalf("restore = (%#v, %v, %v), want (nil, false, nil)", cmd, ok, err)
	}
}

func TestBinarySpecCoversWindowsExecutableAndShims(t *testing.T) {
	for _, name := range []string{"deveco.exe", "deveco.cmd", "deveco.bat"} {
		if !contains(devecoBinarySpec.WinNames, name) {
			t.Fatalf("Windows binary names missing %q: %#v", name, devecoBinarySpec.WinNames)
		}
	}
}

func TestResolveDevEcoBinaryFindsNativeNPMTargetOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows resolver shape")
	}
	home := t.TempDir()
	appData := filepath.Join(home, "AppData", "Roaming")
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", appData)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	t.Setenv("PATH", t.TempDir())
	native := filepath.Join(appData, "npm", "node_modules", "@deveco", "deveco-code-windows-x64", "bin", "deveco.exe")
	if err := os.MkdirAll(filepath.Dir(native), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(native, []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := ResolveDevEcoBinary(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got != native {
		t.Fatalf("binary = %q, want %q", got, native)
	}
}

func TestResolveDevEcoBinaryHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ResolveDevEcoBinary(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestActivityDerivationMatchesDevEcoLifecycle(t *testing.T) {
	tests := map[string]domain.ActivityState{
		"session-start":      domain.ActivityActive,
		"user-prompt-submit": domain.ActivityActive,
		"active":             domain.ActivityActive,
		"stop":               domain.ActivityIdle,
		"permission-blocked": domain.ActivityBlocked,
	}
	for event, want := range tests {
		got, ok := DeriveActivityState(event, nil)
		if !ok || got != want {
			t.Fatalf("DeriveActivityState(%q) = (%q, %v), want (%q, true)", event, got, ok, want)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

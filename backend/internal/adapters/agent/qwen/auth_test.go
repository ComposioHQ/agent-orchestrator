package qwen

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/authprobe"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestQwenLocalAuthStatusAuthorizedWithProviderEnv(t *testing.T) {
	t.Setenv("ZAI_API_KEY", "zai-key")

	status, ok, err := qwenLocalAuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsAuthorizedWithModelProviderAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	content := `{
		"modelProviders": {
			"zai": {
				"baseUrl": "https://api.z.ai/api/coding/paas/v4",
				"apiKey": "zai-key"
			}
		},
		"defaultModel": "glm-4.5"
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := qwenAuthStatusFromSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsAuthorizedWithSecurityAuthAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	content := `{
		"security": {
			"auth": {
				"apiKey": "openai-compatible-key"
			}
		}
	}`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	status, ok, err := qwenAuthStatusFromSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestQwenAuthStatusFromSettingsUnknownWhenMissing(t *testing.T) {
	status, ok, err := qwenAuthStatusFromSettings(filepath.Join(t.TempDir(), "missing.json"))
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func TestAuthStatusUsesQwenDoctor(t *testing.T) {
	restore := mockQwenAuthProbeRunner(t, func(_ context.Context, name string, arg ...string) ([]byte, error) {
		if name != "qwen" || !reflect.DeepEqual(arg, []string{"doctor"}) {
			t.Fatalf("command = %s %#v, want qwen doctor", name, arg)
		}
		return []byte("Authentication: authenticated"), nil
	})
	defer restore()

	status, err := (&Plugin{resolvedBinary: "qwen"}).AuthStatus(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = %q, want %q", status, ports.AgentAuthStatusAuthorized)
	}
}

func mockQwenAuthProbeRunner(t *testing.T, runner func(context.Context, string, ...string) ([]byte, error)) func() {
	t.Helper()
	previous := authprobe.CmdRunner
	authprobe.CmdRunner = runner
	return func() { authprobe.CmdRunner = previous }
}

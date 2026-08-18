package crush

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestCrushProvidersAuthStatusAuthorizedWithAPIKey(t *testing.T) {
	path := writeCrushProviders(t, `[{"id":"anthropic","api_key":"sk-test"}]`)

	status, ok, err := crushProvidersAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || status != ports.AgentAuthStatusAuthorized {
		t.Fatalf("status = (%q, %v), want (%q, true)", status, ok, ports.AgentAuthStatusAuthorized)
	}
}

func TestCrushProvidersAuthStatusUnknownWithEmptyAPIKeys(t *testing.T) {
	path := writeCrushProviders(t, `[{"id":"anthropic","api_key":""}]`)

	status, ok, err := crushProvidersAuthStatus(path)
	if err != nil {
		t.Fatal(err)
	}
	if ok || status != ports.AgentAuthStatusUnknown {
		t.Fatalf("status = (%q, %v), want (%q, false)", status, ok, ports.AgentAuthStatusUnknown)
	}
}

func writeCrushProviders(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "providers.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

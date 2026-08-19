package crush

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	_, err := p.ResolveBinary(ctx)
	if err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if status, ok, err := crushLocalAuthStatus(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	} else if ok {
		return status, nil
	}
	return ports.AgentAuthStatusUnknown, nil
}

func crushLocalAuthStatus(ctx context.Context) (ports.AgentAuthStatus, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	for _, name := range []string{
		"HYPER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "VERCEL_API_KEY",
		"GEMINI_API_KEY", "ZAI_API_KEY", "MINIMAX_API_KEY", "SYNTHETIC_API_KEY",
		"HF_TOKEN", "CEREBRAS_API_KEY", "OPENROUTER_API_KEY", "IONET_API_KEY",
		"ALIBABA_SINGAPORE_API_KEY", "ALIBABA_US_API_KEY", "GROQ_API_KEY",
		"AVIAN_API_KEY", "OPENCODE_API_KEY", "AZURE_OPENAI_API_KEY", "MOONSHOT_API_KEY",
		"AWS_BEARER_TOKEN_BEDROCK",
	} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	if strings.TrimSpace(os.Getenv("AWS_ACCESS_KEY_ID")) != "" &&
		strings.TrimSpace(os.Getenv("AWS_SECRET_ACCESS_KEY")) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	if strings.TrimSpace(os.Getenv("AWS_PROFILE")) != "" {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	if strings.TrimSpace(os.Getenv("VERTEXAI_PROJECT")) != "" &&
		strings.TrimSpace(os.Getenv("VERTEXAI_LOCATION")) != "" &&
		crushGoogleCredentialConfigured() {
		return ports.AgentAuthStatusAuthorized, true, nil
	}
	dataDir, ok := crushDataDir()
	if !ok {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	return crushProvidersAuthStatus(filepath.Join(dataDir, "providers.json"))
}

func crushGoogleCredentialConfigured() bool {
	if path := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")); path != "" {
		return crushNonEmptyRegularFile(path)
	}
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		return crushNonEmptyRegularFile(filepath.Join(configHome, "gcloud", "application_default_credentials.json"))
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		return crushNonEmptyRegularFile(filepath.Join(appData, "gcloud", "application_default_credentials.json"))
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	return crushNonEmptyRegularFile(filepath.Join(home, ".config", "gcloud", "application_default_credentials.json"))
}

func crushNonEmptyRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func crushDataDir() (string, bool) {
	if dataDir := strings.TrimSpace(os.Getenv("CRUSH_DATA_DIR")); dataDir != "" {
		return dataDir, true
	}
	if dataHome := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dataHome != "" {
		return filepath.Join(dataHome, "crush"), true
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", false
	}
	return filepath.Join(home, ".local", "share", "crush"), true
}

type crushProviderAuth struct {
	APIKey string `json:"api_key"`
}

func crushProvidersAuthStatus(path string) (ports.AgentAuthStatus, bool, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	if err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if strings.TrimSpace(string(data)) == "" {
		return ports.AgentAuthStatusUnknown, false, nil
	}

	var providers []crushProviderAuth
	if err := json.Unmarshal(data, &providers); err != nil {
		return ports.AgentAuthStatusUnknown, false, err
	}
	if len(providers) == 0 {
		return ports.AgentAuthStatusUnknown, false, nil
	}
	for _, provider := range providers {
		if strings.TrimSpace(provider.APIKey) != "" {
			return ports.AgentAuthStatusAuthorized, true, nil
		}
	}
	return ports.AgentAuthStatusUnknown, false, nil
}

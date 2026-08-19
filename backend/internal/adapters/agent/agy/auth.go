package agy

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.AgentAuthChecker = (*Plugin)(nil)

// AuthStatus returns the plugin's local authentication status.
func (p *Plugin) AuthStatus(ctx context.Context) (ports.AgentAuthStatus, error) {
	if _, err := p.ResolveBinary(ctx); err != nil {
		return ports.AgentAuthStatusUnknown, err
	}
	if agyADCCredentialConfigured() {
		return ports.AgentAuthStatusAuthorized, nil
	}
	// Browser and enterprise logins are held in OS credential stores. AGY does
	// not document a non-interactive account-status command, so their absence
	// cannot safely be inferred here.
	return ports.AgentAuthStatusUnknown, nil
}

func agyADCCredentialConfigured() bool {
	if path := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")); path != "" {
		return nonEmptyRegularFile(path)
	}
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		return nonEmptyRegularFile(filepath.Join(configHome, "gcloud", "application_default_credentials.json"))
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		return nonEmptyRegularFile(filepath.Join(appData, "gcloud", "application_default_credentials.json"))
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return false
	}
	return nonEmptyRegularFile(filepath.Join(home, ".config", "gcloud", "application_default_credentials.json"))
}

func nonEmptyRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

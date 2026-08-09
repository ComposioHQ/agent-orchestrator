// Package kimchiacp binds the user's own Kimchi installation to AO's
// reusable ACP Chat transport.
package kimchiacp

import (
	"log/slog"
	"strings"

	acpdriver "github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/acp"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/nativeacp"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// New launches `kimchi --mode acp` from the exact binary resolved by the
// existing Kimchi agent plugin. Login, models, settings, and updates remain
// owned by the user's Kimchi installation.
func New(plugin nativeacp.Plugin, log *slog.Logger) ports.ChatDriver {
	return nativeacp.New(plugin, nativeacp.Config{
		Harness:        domain.HarnessKimchi,
		Configure:      configure,
		SessionMode:    sessionMode,
		SessionOptions: sessionOptions,
	}, log)
}

func configure(cfg acpdriver.LaunchConfig) ([]string, map[string]string, error) {
	args := []string{"--mode", "acp"}
	if strings.TrimSpace(cfg.SystemPrompt) != "" {
		args = append(args, "--append-system-prompt", cfg.SystemPrompt)
	}
	return args, nil, nil
}

func sessionMode(permission ports.PermissionMode) string {
	switch ports.NormalizePermissionMode(permission) {
	case ports.PermissionModeAcceptEdits, ports.PermissionModeAuto:
		return "auto"
	case ports.PermissionModeBypassPermissions:
		return "yolo"
	default:
		return ""
	}
}

func sessionOptions(settings ports.ChatTurnSettings) []acpdriver.SessionOption {
	if settings.Model == "" {
		return nil
	}
	return []acpdriver.SessionOption{{ID: "model", Value: settings.Model}}
}

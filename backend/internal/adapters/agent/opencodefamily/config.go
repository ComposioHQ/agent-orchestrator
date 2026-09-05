// Package opencodefamily contains the small pieces of adapter behavior shared
// by OpenCode and source-compatible descendants. It deliberately does not
// choose binaries, config directories, or hook locations for an adapter.
package opencodefamily

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
)

// InlineConfig is the minimal OpenCode-compatible configuration AO writes for
// a session-specific primary agent.
type InlineConfig struct {
	Schema string                   `json:"$schema,omitempty"`
	Agent  map[string]AgentSettings `json:"agent,omitempty"`
}

// AgentSettings is the subset required to inject AO's standing instructions.
type AgentSettings struct {
	Mode   string `json:"mode,omitempty"`
	Prompt string `json:"prompt,omitempty"`
}

// ConfigEnvPrefix writes an AO-owned config beside the system-prompt artifact
// and returns the existing adapter argv convention: env NAME=path. The runtime
// translates this prefix into a real environment variable on Windows.
func ConfigEnvPrefix(adapterLabel, envVar, configFilename, inlinePrompt, promptFile, sessionID string) ([]string, string, error) {
	if inlinePrompt == "" && promptFile == "" {
		return nil, "", nil
	}
	if promptFile == "" {
		return nil, "", fmt.Errorf("%s: system prompt file required to build agent config", adapterLabel)
	}
	agentName := AOAgentName(sessionID)
	prompt := inlinePrompt
	if prompt == "" {
		prompt = "{file:./" + filepath.Base(promptFile) + "}"
	}
	dir := filepath.Dir(promptFile)
	configPath := filepath.Join(dir, configFilename)
	config := InlineConfig{
		Schema: "https://opencode.ai/config.json",
		Agent: map[string]AgentSettings{
			agentName: {
				Mode:   "primary",
				Prompt: prompt,
			},
		},
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return nil, "", err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, "", fmt.Errorf("%s: create prompt config dir: %w", adapterLabel, err)
	}
	if err := hookutil.AtomicWriteFile(configPath, data, 0o600); err != nil {
		return nil, "", fmt.Errorf("%s: write prompt config: %w", adapterLabel, err)
	}
	return []string{"env", envVar + "=" + configPath}, agentName, nil
}

// AOAgentName returns a stable, config-safe agent name for one AO session.
func AOAgentName(sessionID string) string {
	const fallback = "ao-system-prompt"
	trimmed := strings.TrimSpace(sessionID)
	if trimmed == "" {
		return fallback
	}
	var b strings.Builder
	for _, r := range trimmed {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-',
			r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	name := strings.Trim(b.String(), "-_")
	if name == "" {
		return fallback
	}
	return "ao-" + name
}

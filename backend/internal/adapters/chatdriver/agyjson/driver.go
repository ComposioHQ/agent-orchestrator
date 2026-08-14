// Package agyjson implements AO Chat UI over Agy's machine-readable print mode.
// The native Agy terminal adapter remains unchanged; this driver is used only
// when a session explicitly runs in Chat mode.
package agyjson

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/hookutil"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const (
	hookDirName        = ".agents"
	hookFileName       = "hooks.json"
	managedHookName    = "agent-orchestrator-chat"
	hookTokenEnv       = "AO_AGY_CHAT_HOOK_TOKEN"
	hookCommandPrefix  = "ao agy-chat-hook "
	hookTimeoutSeconds = 3600
)

type agyPlugin interface {
	ResolveBinary(context.Context) (string, error)
	AuthStatus(context.Context) (ports.AgentAuthStatus, error)
}

// Driver opens Agy conversations using `agy --print --output-format stream-json`.
type Driver struct {
	plugin agyPlugin
	log    *slog.Logger
}

func New(plugin agyPlugin, log *slog.Logger) *Driver {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Driver{plugin: plugin, log: log}
}

var _ ports.ChatDriver = (*Driver)(nil)

func (d *Driver) Harness() domain.AgentHarness { return domain.HarnessAgy }

func capabilities() ports.ChatCapabilities {
	return ports.ChatCapabilities{
		ports.ChatCapabilityStreaming: true,
		ports.ChatCapabilityTools:     true,
		ports.ChatCapabilityApprovals: true,
		ports.ChatCapabilityInterrupt: true,
		ports.ChatCapabilityResume:    true,
		ports.ChatCapabilityUsage:     true,
	}
}

// Probe verifies the installed Agy exposes structured print output. That surface
// is the machine protocol for this driver; terminal rendering is never scraped.
func (d *Driver) Probe(ctx context.Context) (ports.ChatCapabilities, error) {
	binary, err := d.plugin.ResolveBinary(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatDriverUnavailable, err)
	}
	status, authErr := d.plugin.AuthStatus(ctx)
	if authErr == nil && status == ports.AgentAuthStatusUnauthorized {
		return nil, ports.ErrChatAuthRequired
	}
	if authErr != nil {
		d.log.Debug("agy auth probe inconclusive; continuing", "error", authErr)
	}

	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := aoprocess.CommandContext(probeCtx, binary, "--help").CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%w: read Agy help: %v", ports.ErrChatDriverIncompatible, err)
	}
	if !bytes.Contains(out, []byte("--output-format")) || !bytes.Contains(out, []byte("stream-json")) {
		return nil, fmt.Errorf("%w: installed Agy does not expose --output-format stream-json", ports.ErrChatDriverIncompatible)
	}
	return capabilities(), nil
}

func (d *Driver) Start(ctx context.Context, cfg ports.ChatStartConfig) (ports.ChatConversation, error) {
	if len(cfg.MCPServers) != 0 {
		return nil, fmt.Errorf("%w: Agy stream-json chat does not yet support AO-supplied MCP servers", ports.ErrChatUnsupported)
	}
	binary, err := d.plugin.ResolveBinary(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatDriverUnavailable, err)
	}
	return d.newConversation(ctx, binary, conversationConfig{
		sessionID:             cfg.SessionID,
		workspacePath:         cfg.WorkspacePath,
		env:                   cfg.Env,
		model:                 cfg.Model,
		permissions:           cfg.Permissions,
		systemPrompt:          cfg.SystemPrompt,
		additionalDirectories: cfg.AdditionalDirectories,
	})
}

func (d *Driver) Resume(ctx context.Context, cfg ports.ChatResumeConfig) (ports.ChatConversation, error) {
	if len(cfg.MCPServers) != 0 {
		return nil, fmt.Errorf("%w: Agy stream-json chat does not yet support AO-supplied MCP servers", ports.ErrChatUnsupported)
	}
	providerID := strings.TrimSpace(cfg.ProviderConversationID)
	if providerID == "" {
		return nil, fmt.Errorf("%w: Agy conversation id is empty", ports.ErrChatResumeFailed)
	}
	binary, err := d.plugin.ResolveBinary(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ports.ErrChatDriverUnavailable, err)
	}
	conv, err := d.newConversation(ctx, binary, conversationConfig{
		sessionID:              cfg.SessionID,
		workspacePath:          cfg.WorkspacePath,
		env:                    cfg.Env,
		permissions:            cfg.Permissions,
		systemPrompt:           cfg.SystemPrompt,
		additionalDirectories:  cfg.AdditionalDirectories,
		providerConversationID: providerID,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ports.ErrChatResumeFailed, err)
	}
	return conv, nil
}

type conversationConfig struct {
	sessionID              domain.SessionID
	workspacePath          string
	env                    map[string]string
	model                  string
	permissions            ports.PermissionMode
	systemPrompt           string
	additionalDirectories  []string
	providerConversationID string
}

func (d *Driver) newConversation(ctx context.Context, binary string, cfg conversationConfig) (*conversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.workspacePath) == "" {
		return nil, errors.New("agy chat: workspace path is required")
	}
	if err := installChatHooks(cfg.workspacePath); err != nil {
		return nil, fmt.Errorf("agy chat: install hooks: %w", err)
	}
	token, err := randomToken()
	if err != nil {
		return nil, fmt.Errorf("agy chat: create hook token: %w", err)
	}
	convCtx, cancel := context.WithCancel(context.Background())
	return &conversation{
		ctx:                    convCtx,
		cancel:                 cancel,
		binary:                 binary,
		workspacePath:          cfg.workspacePath,
		env:                    cloneMap(cfg.env),
		model:                  strings.TrimSpace(cfg.model),
		permissions:            cfg.permissions,
		systemPrompt:           cfg.systemPrompt,
		additionalDirectories:  append([]string(nil), cfg.additionalDirectories...),
		providerConversationID: strings.TrimSpace(cfg.providerConversationID),
		hookToken:              token,
		events:                 make(chan ports.ChatEvent, 512),
		deferred:               make(map[string]ports.ChatUserMessage),
		approvals:              make(map[string]chan ports.ChatDecision),
		log:                    d.log,
	}, nil
}

func randomToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func cloneMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in)+1)
	for key, value := range in {
		out[key] = value
	}
	return out
}

type hookFile map[string]json.RawMessage

type hookHandler struct {
	Type    string `json:"type,omitempty"`
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"`
}

type hookMatcherGroup struct {
	Matcher string        `json:"matcher"`
	Hooks   []hookHandler `json:"hooks"`
}

type hookDefinition struct {
	PreInvocation []hookHandler      `json:"PreInvocation"`
	PreToolUse    []hookMatcherGroup `json:"PreToolUse"`
}

func installChatHooks(workspacePath string) error {
	hooksDir := filepath.Join(workspacePath, hookDirName)
	hooksPath := filepath.Join(hooksDir, hookFileName)
	file := hookFile{}
	if data, err := os.ReadFile(hooksPath); err == nil && strings.TrimSpace(string(data)) != "" {
		if err := json.Unmarshal(data, &file); err != nil {
			return fmt.Errorf("parse %s: %w", hooksPath, err)
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read %s: %w", hooksPath, err)
	}
	if file == nil {
		file = hookFile{}
	}

	definition := hookDefinition{
		PreInvocation: []hookHandler{{
			Type: "command", Command: hookCommandPrefix + "pre-invocation", Timeout: hookTimeoutSeconds,
		}},
		PreToolUse: []hookMatcherGroup{{
			Matcher: "*",
			Hooks: []hookHandler{{
				Type: "command", Command: hookCommandPrefix + "pre-tool-use", Timeout: hookTimeoutSeconds,
			}},
		}},
	}
	raw, err := json.Marshal(definition)
	if err != nil {
		return err
	}
	file[managedHookName] = raw
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(hooksDir, 0o750); err != nil {
		return err
	}
	if err := hookutil.AtomicWriteFile(hooksPath, data, 0o600); err != nil {
		return err
	}
	return hookutil.EnsureWorkspaceGitignore(hooksDir, hookFileName)
}

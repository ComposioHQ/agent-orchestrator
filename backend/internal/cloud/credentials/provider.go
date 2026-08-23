package credentials

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
)

type Harness string

const HarnessClaudeCode Harness = ProviderClaudeCode

// CredentialFile is the provider-neutral file contract consumed by sandbox
// bootstrap. Content is transient and must be erased after the sandbox API
// has accepted a copy. Path is always relative to the sandbox user's home.
type CredentialFile struct {
	Path    string
	Mode    fs.FileMode
	Content []byte
}

func (f CredentialFile) Erase() { Erase(f.Content) }

// HarnessCredentialProvider isolates provider-specific validation and file layout.
type HarnessCredentialProvider interface {
	Harness() Harness
	Inspect([]byte) (credentialType string, error error)
	Materialize([]byte) ([]CredentialFile, error)
}

type ClaudeCodeProvider struct{}

func (ClaudeCodeProvider) Harness() Harness { return HarnessClaudeCode }

type claudeCredentialDocument struct {
	ClaudeAIOAuth *struct {
		AccessToken string `json:"accessToken"`
	} `json:"claudeAiOauth"`
}

func parseClaudeCredential(plaintext []byte) error {
	if len(bytes.TrimSpace(plaintext)) == 0 || len(plaintext) > 65536 {
		return fmt.Errorf("%w: malformed Claude Code credential", ErrInvalid)
	}
	var document claudeCredentialDocument
	if err := json.Unmarshal(plaintext, &document); err != nil || document.ClaudeAIOAuth == nil || document.ClaudeAIOAuth.AccessToken == "" {
		return fmt.Errorf("%w: malformed Claude Code credential", ErrInvalid)
	}
	return nil
}

func (ClaudeCodeProvider) Inspect(plaintext []byte) (string, error) {
	if err := parseClaudeCredential(plaintext); err != nil {
		return "", err
	}
	return TypeOAuthToken, nil
}

func (ClaudeCodeProvider) Materialize(plaintext []byte) ([]CredentialFile, error) {
	if err := parseClaudeCredential(plaintext); err != nil {
		return nil, err
	}
	content := append([]byte(nil), plaintext...)
	return []CredentialFile{{Path: ".claude/.credentials.json", Mode: 0o600, Content: content}}, nil
}

type ProviderRegistry struct {
	providers map[Harness]HarnessCredentialProvider
}

func NewProviderRegistry(providers ...HarnessCredentialProvider) (*ProviderRegistry, error) {
	registry := &ProviderRegistry{providers: make(map[Harness]HarnessCredentialProvider, len(providers))}
	for _, provider := range providers {
		if provider == nil {
			return nil, errors.New("credential provider is required")
		}
		if _, exists := registry.providers[provider.Harness()]; exists {
			return nil, fmt.Errorf("duplicate credential provider for %q", provider.Harness())
		}
		registry.providers[provider.Harness()] = provider
	}
	if len(registry.providers) == 0 {
		return nil, errors.New("at least one credential provider is required")
	}
	return registry, nil
}

func defaultProviderRegistry() *ProviderRegistry {
	registry, err := NewProviderRegistry(ClaudeCodeProvider{})
	if err != nil {
		panic(err)
	}
	return registry
}

func (r *ProviderRegistry) Provider(harness Harness) (HarnessCredentialProvider, error) {
	provider, ok := r.providers[harness]
	if !ok {
		return nil, fmt.Errorf("%w: unsupported provider %q", ErrInvalid, harness)
	}
	return provider, nil
}

// SecretFileSink is exactly the interface implemented by worker 181's
// sandboxruntime.FileSecret. The caller constructs it with the harness config
// directory as its root (for Claude Code, $HOME/.claude).
type SecretFileSink interface {
	Deliver(string, []byte, fs.FileMode) (string, error)
	Purge() error
}

type BootstrapScope struct {
	OrgID       string
	WorkspaceID string
	SandboxID   string
	Harness     Harness
}

func (s BootstrapScope) validate() error {
	if strings.TrimSpace(s.OrgID) == "" || strings.TrimSpace(s.WorkspaceID) == "" || strings.TrimSpace(s.SandboxID) == "" {
		return errors.New("credential bootstrap requires org, workspace, and sandbox ids")
	}
	return nil
}

func validateFileSecrets(files []CredentialFile) error {
	if len(files) == 0 {
		return errors.New("credential provider produced no files")
	}
	for _, file := range files {
		clean := filepath.Clean(file.Path)
		if file.Mode != 0o600 || filepath.IsAbs(file.Path) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return errors.New("credential provider produced an unsafe file secret")
		}
	}
	return nil
}

var _ HarnessCredentialProvider = ClaudeCodeProvider{}

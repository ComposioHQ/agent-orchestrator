package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
)

// SecretFile is transient bootstrap material for a path relative to the
// sandbox user's home. Content is valid only for the duration of one
// DeliverSecretFiles call and is zeroed by DeliveryService immediately after.
type SecretFile struct {
	Path    string
	Mode    fs.FileMode
	Content []byte
}

// SecretFileSink is implemented by the compute/runtime transport. It must
// write remotely inside sandboxID, never on the control-plane filesystem, and
// must return from DeliverSecretFiles only after the harness has consumed the
// file. PurgeSecretFiles must be remote and idempotent.
type SecretFileSink interface {
	DeliverSecretFiles(ctx context.Context, sandboxID string, files []SecretFile) error
	PurgeSecretFiles(ctx context.Context, sandboxID string, paths []string) error
}

// HarnessCredentialProvider isolates provider-specific validation and remote
// file layout. Implementations may only materialize owner-only relative files.
type HarnessCredentialProvider interface {
	Provider() Provider
	MaterializeBootstrap([]byte) ([]SecretFile, error)
}

type ClaudeProvider struct{}

func (ClaudeProvider) Provider() Provider { return ProviderClaude }

type claudeCredentialDocument struct {
	ClaudeAIOAuth *struct {
		AccessToken string `json:"accessToken"`
	} `json:"claudeAiOauth"`
}

func (ClaudeProvider) MaterializeBootstrap(plaintext []byte) ([]SecretFile, error) {
	if len(bytes.TrimSpace(plaintext)) == 0 || len(plaintext) > 64*1024 {
		return nil, fmt.Errorf("%w: malformed Claude credential", ErrInvalid)
	}
	var document claudeCredentialDocument
	if err := json.Unmarshal(plaintext, &document); err != nil || document.ClaudeAIOAuth == nil || strings.TrimSpace(document.ClaudeAIOAuth.AccessToken) == "" {
		return nil, fmt.Errorf("%w: malformed Claude credential", ErrInvalid)
	}
	// Reuse the delivery-owned buffer; do not create a second plaintext copy.
	return []SecretFile{{Path: ".claude/.credentials.json", Mode: 0o600, Content: plaintext}}, nil
}

type ProviderRegistry struct {
	providers map[Provider]HarnessCredentialProvider
}

func NewProviderRegistry(providers ...HarnessCredentialProvider) (*ProviderRegistry, error) {
	registry := &ProviderRegistry{providers: make(map[Provider]HarnessCredentialProvider, len(providers))}
	for _, provider := range providers {
		if provider == nil || strings.TrimSpace(string(provider.Provider())) == "" {
			return nil, errors.New("harness credential provider is required")
		}
		if _, exists := registry.providers[provider.Provider()]; exists {
			return nil, fmt.Errorf("duplicate harness credential provider %q", provider.Provider())
		}
		registry.providers[provider.Provider()] = provider
	}
	if len(registry.providers) == 0 {
		return nil, errors.New("at least one harness credential provider is required")
	}
	return registry, nil
}

func (r *ProviderRegistry) provider(id Provider) (HarnessCredentialProvider, error) {
	provider, ok := r.providers[id]
	if !ok {
		return nil, fmt.Errorf("%w: unsupported harness credential provider %q", ErrInvalid, id)
	}
	return provider, nil
}

func validateSecretFiles(files []SecretFile) error {
	if len(files) == 0 {
		return fmt.Errorf("%w: provider produced no bootstrap files", ErrInvalid)
	}
	for _, file := range files {
		clean := path.Clean(file.Path)
		if file.Mode != 0o600 || path.IsAbs(file.Path) || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || len(file.Content) == 0 {
			return fmt.Errorf("%w: provider produced an unsafe bootstrap file", ErrInvalid)
		}
	}
	return nil
}

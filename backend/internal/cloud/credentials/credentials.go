// Package credentials owns encrypted coding-harness credential custody for AO Cloud.
// Plaintext is accepted and returned only as mutable byte slices so callers can
// erase it as soon as a sandbox secret has been materialized.
package credentials

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	ProviderClaudeCode = "claude-code"

	TypeOAuthToken  = "oauth_token"
	TypeAPIKey      = "api_key"
	TypeAccessToken = "access_token"
)

var (
	ErrNotFound = errors.New("harness credential not found")
	ErrInvalid  = errors.New("invalid harness credential")
	ErrRevoked  = errors.New("harness credential revoked")
)

// EncryptedMaterial is the only secret representation persistence may receive.
type EncryptedMaterial struct {
	Ciphertext       []byte
	EncryptedDataKey []byte
	Nonce            []byte
	KeyID            string
}

// Record is the durable encrypted credential and its redacted metadata.
type Record struct {
	ID             string
	OrgID          string
	OwnerUserID    string
	Provider       string
	CredentialType string
	Material       EncryptedMaterial
	Version        int64
	CreatedAt      time.Time
	UpdatedAt      time.Time
	RotatedAt      *time.Time
}

// Metadata is safe to return to clients. It intentionally cannot carry secret bytes.
type Metadata struct {
	ID             string    `json:"id"`
	Provider       string    `json:"provider"`
	CredentialType string    `json:"credentialType"`
	Version        int64     `json:"version"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

// Store persists ciphertext and immutable audit events under the tenant scope in ctx.
type Store interface {
	Put(context.Context, string, string, EncryptedMaterial) (Record, error)
	List(context.Context) ([]Metadata, error)
	Get(context.Context, string) (Record, error)
	GetForWorkspace(context.Context, string, string, string, string) (Record, error)
	Delete(context.Context, string) error
	Audit(context.Context, string, string, string, int64) error
	AuditWorkspace(context.Context, string, string, string, string, string, int64) error
}

// Envelope encrypts/decrypts one credential using a fresh data key.
type Envelope interface {
	Encrypt(context.Context, []byte, map[string]string) (EncryptedMaterial, error)
	Decrypt(context.Context, EncryptedMaterial, map[string]string) ([]byte, error)
}

// Service is provider-neutral credential custody. Provider-specific validation
// belongs at import time and never changes the encryption or storage boundary.
type Service struct {
	store    Store
	envelope Envelope
	registry *ProviderRegistry
}

func NewService(store Store, envelope Envelope) (*Service, error) {
	if store == nil || envelope == nil {
		return nil, errors.New("credential store and envelope are required")
	}
	return &Service{store: store, envelope: envelope, registry: defaultProviderRegistry()}, nil
}

func Validate(provider, credentialType string, secret []byte) error {
	provider = strings.TrimSpace(provider)
	credentialType = strings.TrimSpace(credentialType)
	if provider != ProviderClaudeCode {
		return fmt.Errorf("%w: unsupported provider %q", ErrInvalid, provider)
	}
	if credentialType != TypeOAuthToken && credentialType != TypeAPIKey && credentialType != TypeAccessToken {
		return fmt.Errorf("%w: unsupported credential type %q", ErrInvalid, credentialType)
	}
	if len(secret) == 0 || len(secret) > 65536 {
		return fmt.Errorf("%w: secret length must be between 1 and 65536 bytes", ErrInvalid)
	}
	return nil
}

func (s *Service) Put(ctx context.Context, provider, credentialType string, secret []byte) (Metadata, error) {
	if err := Validate(provider, credentialType, secret); err != nil {
		return Metadata{}, err
	}
	harnessProvider, err := s.registry.Provider(Harness(provider))
	if err != nil {
		return Metadata{}, err
	}
	inspectedType, err := harnessProvider.Inspect(secret)
	if err != nil {
		return Metadata{}, err
	}
	if inspectedType != credentialType {
		return Metadata{}, fmt.Errorf("%w: credential type does not match the provider secret", ErrInvalid)
	}
	scope, err := ScopeFromContext(ctx)
	if err != nil {
		return Metadata{}, err
	}
	material, err := s.envelope.Encrypt(ctx, secret, encryptionContext(scope, provider))
	if err != nil {
		return Metadata{}, fmt.Errorf("encrypt harness credential: %w", err)
	}
	record, err := s.store.Put(ctx, provider, credentialType, material)
	if err != nil {
		return Metadata{}, err
	}
	return metadata(record), nil
}

// DeliverToSandbox decrypts only after a workspace-scoped store lookup, renders
// provider files, passes them to bootstrap, and erases every control-plane copy.
func (s *Service) DeliverToSandbox(ctx context.Context, scope BootstrapScope, sink SecretFileSink) error {
	if err := scope.validate(); err != nil {
		return err
	}
	if sink == nil {
		return errors.New("credential bootstrap requires a secret-file sink")
	}
	provider, err := s.registry.Provider(scope.Harness)
	if err != nil {
		return err
	}
	record, err := s.store.GetForWorkspace(ctx, scope.OrgID, scope.WorkspaceID, string(scope.Harness), scope.SandboxID)
	if err != nil {
		return err
	}
	binding := map[string]string{"ao:org-id": record.OrgID, "ao:user-id": record.OwnerUserID, "ao:provider": record.Provider}
	secret, err := s.envelope.Decrypt(ctx, record.Material, binding)
	if err != nil {
		return fmt.Errorf("decrypt bootstrap credential: %w", err)
	}
	defer Erase(secret)
	files, err := provider.Materialize(secret)
	if err != nil {
		return err
	}
	defer func() {
		for _, file := range files {
			file.Erase()
		}
	}()
	if err := validateFileSecrets(files); err != nil {
		return err
	}
	deliveryErr := sink.DeliverSecretFiles(ctx, scope.SandboxID, files)
	var materializedErr error
	if deliveryErr == nil {
		materializedErr = s.store.AuditWorkspace(ctx, scope.OrgID, scope.WorkspaceID, scope.SandboxID, record.Provider, "credential.materialized", record.Version)
	}
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, file.Path)
	}
	remotePurgeErr := sink.PurgeSecretFiles(ctx, scope.SandboxID, paths)
	var purgeAuditErr error
	if remotePurgeErr == nil {
		purgeAuditErr = s.store.AuditWorkspace(ctx, scope.OrgID, scope.WorkspaceID, scope.SandboxID, record.Provider, "credential.purged", record.Version)
	}
	if deliveryErr != nil {
		deliveryErr = fmt.Errorf("deliver credential files: %w", deliveryErr)
	}
	if remotePurgeErr != nil {
		remotePurgeErr = fmt.Errorf("purge credential files: %w", remotePurgeErr)
	}
	return errors.Join(deliveryErr, materializedErr, remotePurgeErr, purgeAuditErr)
}

func (s *Service) List(ctx context.Context) ([]Metadata, error) { return s.store.List(ctx) }

func (s *Service) Delete(ctx context.Context, provider string) error {
	if provider != ProviderClaudeCode {
		return fmt.Errorf("%w: unsupported provider %q", ErrInvalid, provider)
	}
	return s.store.Delete(ctx, provider)
}

// Decrypt returns transient credential bytes. The caller owns and must erase them.
func (s *Service) Decrypt(ctx context.Context, provider string) ([]byte, string, error) {
	record, err := s.store.Get(ctx, provider)
	if err != nil {
		return nil, "", err
	}
	scope, err := ScopeFromContext(ctx)
	if err != nil {
		return nil, "", err
	}
	secret, err := s.envelope.Decrypt(ctx, record.Material, encryptionContext(scope, provider))
	if err != nil {
		return nil, "", fmt.Errorf("decrypt harness credential: %w", err)
	}
	if err := s.store.Audit(ctx, record.ID, record.Provider, "credential.decrypted", record.Version); err != nil {
		Erase(secret)
		return nil, "", err
	}
	return secret, record.CredentialType, nil
}

func metadata(record Record) Metadata {
	return Metadata{ID: record.ID, Provider: record.Provider, CredentialType: record.CredentialType, Version: record.Version, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
}

// Erase clears a transient secret in place. Callers should defer it immediately.
func Erase(secret []byte) {
	for i := range secret {
		secret[i] = 0
	}
}

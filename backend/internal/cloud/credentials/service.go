package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// PutCredential carries one ciphertext-only create or optimistic rotation write.
type PutCredential struct {
	Record          CredentialRecord
	ExpectedVersion int64
}

// CustodyStore persists ciphertext-only versions. PutCredential, Revoke, and
// their immutable audit event must each be one transaction.
type CustodyStore interface {
	PutCredential(context.Context, PutCredential) (CredentialRecord, error)
	ListCredentials(context.Context) ([]Metadata, error)
	GetCredential(context.Context, Provider) (CredentialRecord, error)
	RevokeCredential(context.Context, Provider) error
}

// ImportRequest is bounded transient import material plus redacted metadata.
type ImportRequest struct {
	Name     string
	Provider Provider
	Metadata json.RawMessage
	Secret   []byte
}

// VaultService manages ciphertext custody. A nil envelope is deliberately
// accepted so deployments that do not use the vault can start; import,
// rotation, and delivery then fail closed.
type VaultService struct {
	store    CustodyStore
	envelope *KMSEnvelope
}

// NewVaultService constructs custody; envelope may be nil when the vault is unused.
func NewVaultService(store CustodyStore, envelope *KMSEnvelope) (*VaultService, error) {
	if store == nil {
		return nil, fmt.Errorf("%w: credential store is required", ErrInvalid)
	}
	return &VaultService{store: store, envelope: envelope}, nil
}

// Import validates and envelope-encrypts a first provider credential version.
func (s *VaultService) Import(ctx context.Context, request ImportRequest) (Metadata, error) {
	if s.envelope == nil {
		return Metadata{}, ErrKMSUnavailable
	}
	identity, err := validatedImport(ctx, request)
	if err != nil {
		return Metadata{}, err
	}
	record := CredentialRecord{
		ID: uuid.NewString(), OrgID: identity.OrgID, OwnerUserID: identity.UserID,
		Name: request.Name, Provider: request.Provider, Metadata: append(json.RawMessage(nil), request.Metadata...),
		PlaintextBytes: int64(len(request.Secret)), Version: 1,
	}
	record.Material, err = s.envelope.seal(ctx, request.Secret, recordEncryptionContext(record))
	if err != nil {
		return Metadata{}, ErrKMSUnavailable
	}
	stored, err := s.store.PutCredential(ctx, PutCredential{Record: record, ExpectedVersion: 0})
	if err != nil {
		return Metadata{}, err
	}
	return metadataOf(stored), nil
}

// Rotate atomically replaces a live credential with a newly encrypted version.
func (s *VaultService) Rotate(ctx context.Context, request ImportRequest) (Metadata, error) {
	if s.envelope == nil {
		return Metadata{}, ErrKMSUnavailable
	}
	identity, err := validatedImport(ctx, request)
	if err != nil {
		return Metadata{}, err
	}
	current, err := s.store.GetCredential(ctx, request.Provider)
	if err != nil {
		return Metadata{}, err
	}
	if !current.RevokedAt.IsZero() || current.OrgID != identity.OrgID || current.OwnerUserID != identity.UserID {
		return Metadata{}, ErrRevoked
	}
	current.Name = request.Name
	current.Metadata = append(current.Metadata[:0], request.Metadata...)
	current.PlaintextBytes = int64(len(request.Secret))
	current.Version++
	current.Material, err = s.envelope.seal(ctx, request.Secret, recordEncryptionContext(current))
	if err != nil {
		return Metadata{}, ErrKMSUnavailable
	}
	stored, err := s.store.PutCredential(ctx, PutCredential{Record: current, ExpectedVersion: current.Version - 1})
	if err != nil {
		return Metadata{}, err
	}
	return metadataOf(stored), nil
}

// List returns tenant-scoped redacted credential metadata.
func (s *VaultService) List(ctx context.Context) ([]Metadata, error) {
	if _, ok := tenant.FromContext(ctx); !ok {
		return nil, tenant.ErrNoTenant
	}
	return s.store.ListCredentials(ctx)
}

// Revoke remains available when KMS is unavailable: denying future access is
// safer than coupling revocation to a decrypt-capable dependency.
func (s *VaultService) Revoke(ctx context.Context, provider Provider) error {
	if provider != ProviderClaudeCode {
		return ErrInvalid
	}
	if _, ok := tenant.FromContext(ctx); !ok {
		return tenant.ErrNoTenant
	}
	return s.store.RevokeCredential(ctx, provider)
}

func validatedImport(ctx context.Context, request ImportRequest) (tenant.Identity, error) {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.Identity{}, tenant.ErrNoTenant
	}
	if !validBounded(request.Name, MaxCredentialNameBytes) || request.Provider != ProviderClaudeCode ||
		len(request.Metadata) > MaxMetadataBytes || len(request.Secret) == 0 || len(request.Secret) > MaxCredentialBytes {
		return tenant.Identity{}, ErrInvalid
	}
	if len(request.Metadata) > 0 && !json.Valid(request.Metadata) {
		return tenant.Identity{}, ErrInvalid
	}
	if err := validateClaudeCodeCredential(request.Secret); err != nil {
		return tenant.Identity{}, err
	}
	return identity, nil
}

func validateClaudeCodeCredential(secret []byte) error {
	trimmed := bytes.TrimSpace(secret)
	if len(trimmed) != len(secret) || len(trimmed) < 2 || !json.Valid(trimmed) || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return ErrInvalid
	}
	return nil
}

func metadataOf(record CredentialRecord) Metadata {
	return Metadata{ID: record.ID, Name: record.Name, Provider: record.Provider, Metadata: append(json.RawMessage(nil), record.Metadata...),
		Version: record.Version, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt, RevokedAt: record.RevokedAt}
}

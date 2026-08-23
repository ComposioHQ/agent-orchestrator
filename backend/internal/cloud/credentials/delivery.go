package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// DeliveryService is the only credential-vault surface that opens an
// encrypted credential. It never returns plaintext: bytes are passed directly
// to a remote SecretFileSink, purged remotely, and zeroed before return.
type DeliveryService struct {
	store     BootstrapStore
	keys      DataKeyUnwrapper
	providers *ProviderRegistry
}

// NewDeliveryService permits a nil key unwrapper so deployments that do not
// use the vault can still start. DeliverBootstrap always fails closed until a
// working KMS-backed unwrapper is configured.
func NewDeliveryService(store BootstrapStore, keys DataKeyUnwrapper, providers *ProviderRegistry) (*DeliveryService, error) {
	if store == nil {
		return nil, errors.New("credential bootstrap store is required")
	}
	if providers == nil {
		var err error
		providers, err = NewProviderRegistry(ClaudeProvider{})
		if err != nil {
			return nil, err
		}
	}
	return &DeliveryService{store: store, keys: keys, providers: providers}, nil
}

// DeliverBootstrap authorizes exclusively from a verified capability, resolves
// the actual sandbox through durable relationships, opens the envelope, and
// gives the resulting bytes to the runtime's remote delivery port. It accepts
// no sandbox, runtime, workspace, session, or org id from a caller.
func (s *DeliveryService) DeliverBootstrap(
	ctx context.Context,
	verified capability.Verified,
	providerID Provider,
	sink SecretFileSink,
) error {
	if s.keys == nil {
		return ErrKMSUnavailable
	}
	if sink == nil {
		return fmt.Errorf("%w: remote secret-file sink is required", ErrInvalid)
	}
	provider, err := s.providers.provider(providerID)
	if err != nil {
		return err
	}
	lookup, err := bootstrapLookup(verified, providerID)
	if err != nil {
		return err
	}
	record, err := s.store.ResolveBootstrap(ctx, lookup)
	if err != nil {
		return fmt.Errorf("resolve credential bootstrap authorization: %w", err)
	}
	// Defense in depth against an adapter bug or forged store result. SQL is
	// still responsible for performing the authoritative relationship join.
	authorization, err := authorizeBootstrapScope(lookup, record)
	if err != nil {
		return err
	}
	encryptionContext := EncryptionContext{
		CredentialID: record.CredentialID,
		OrgID:        record.OrgID,
		Provider:     record.Provider,
		Version:      record.Version,
	}
	if err := encryptionContext.validate(); err != nil {
		return err
	}
	if err := validateEncryptedMaterial(record.Material); err != nil {
		return err
	}
	dataKey, err := s.keys.UnwrapDataKey(ctx, record.Material.EncryptedDataKey, encryptionContext)
	if err != nil {
		// KMS/provider errors are intentionally not surfaced: adapter errors can
		// contain request metadata and key identifiers.
		return fmt.Errorf("%w: unwrap credential data key", ErrKMSUnavailable)
	}
	defer erase(dataKey)
	plaintext, err := openEnvelope(dataKey, record.Material, encryptionContext.additionalData())
	if err != nil {
		return fmt.Errorf("open authorized credential envelope: %w", err)
	}
	defer erase(plaintext)

	files, err := provider.MaterializeBootstrap(plaintext)
	if err != nil {
		return err
	}
	defer eraseFiles(files)
	if err := validateSecretFiles(files); err != nil {
		return err
	}
	paths := make([]string, len(files))
	for index := range files {
		paths[index] = files[index].Path
	}

	deliveryErr := sink.DeliverSecretFiles(ctx, authorization.SandboxID(), files)
	var materializedAuditErr error
	if deliveryErr == nil {
		materializedAuditErr = s.store.RecordBootstrapEvent(ctx, record, EventMaterialized)
	} else {
		materializedAuditErr = s.store.RecordBootstrapEvent(ctx, record, EventDeliveryFailed)
	}
	// Purge is unconditional, including partial delivery and audit failures.
	// The sink contract makes this a remote idempotent removal.
	purgeErr := sink.PurgeSecretFiles(ctx, authorization.SandboxID(), paths)
	var purgeAuditErr error
	if purgeErr == nil {
		purgeAuditErr = s.store.RecordBootstrapEvent(ctx, record, EventPurged)
	}
	return errors.Join(
		wrapError("deliver remote credential file", deliveryErr),
		wrapError("audit credential materialization", materializedAuditErr),
		wrapError("purge remote credential file", purgeErr),
		wrapError("audit credential purge", purgeAuditErr),
	)
}

func validateEncryptedMaterial(material EncryptedMaterial) error {
	if len(material.Ciphertext) == 0 || len(material.EncryptedDataKey) == 0 || len(material.Nonce) == 0 || strings.TrimSpace(material.KeyID) == "" {
		return fmt.Errorf("%w: incomplete encrypted credential", ErrInvalid)
	}
	return nil
}

func openEnvelope(dataKey []byte, material EncryptedMaterial, additionalData []byte) ([]byte, error) {
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(material.Nonce) != aead.NonceSize() {
		return nil, errors.New("invalid credential envelope nonce")
	}
	return aead.Open(nil, material.Nonce, material.Ciphertext, additionalData)
}

func wrapError(action string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", action, err)
}

func erase(secret []byte) {
	for index := range secret {
		secret[index] = 0
	}
}

func eraseFiles(files []SecretFile) {
	for index := range files {
		erase(files[index].Content)
	}
}

package credentials

import (
	"context"
	"fmt"
	"strings"
)

const maxKMSKeyIDBytes = 512

// EncryptionContext binds both the wrapped data key and AEAD ciphertext to a
// single tenant, owner, provider, credential id, and version.
type EncryptionContext struct {
	CredentialID string
	OrgID        string
	OwnerUserID  string
	Provider     Provider
	Version      int64
}

func (c EncryptionContext) valid() bool {
	return validIdentifier(c.CredentialID) && validIdentifier(c.OrgID) && validIdentifier(c.OwnerUserID) &&
		c.Provider == ProviderClaudeCode && c.Version > 0
}

func (c EncryptionContext) kmsValues() map[string]string {
	return map[string]string{
		"ao:credential-id": c.CredentialID,
		"ao:org-id":        c.OrgID,
		"ao:owner-user-id": c.OwnerUserID,
		"ao:provider":      string(c.Provider),
		"ao:version":       fmt.Sprint(c.Version),
	}
}

// KMSClient is the minimal adapter expected from a production KMS client. It
// never encrypts a credential directly: it only creates and unwraps data keys.
type KMSClient interface {
	GenerateDataKey(context.Context, string, map[string]string) (plaintextKey, encryptedKey []byte, resolvedKeyID string, err error)
	DecryptDataKey(context.Context, string, []byte, map[string]string) ([]byte, error)
}

// KMSKeyManager validates configuration before making any KMS call. A vault
// may be constructed without one, but all operations that touch credential
// material then fail closed with ErrKMSUnavailable.
type KMSKeyManager struct {
	keyID  string
	client KMSClient
}

// NewKMSKeyManager validates the configured key and client without making a network call.
func NewKMSKeyManager(keyID string, client KMSClient) (*KMSKeyManager, error) {
	if strings.TrimSpace(keyID) != keyID || keyID == "" || len(keyID) > maxKMSKeyIDBytes || client == nil {
		return nil, fmt.Errorf("%w: invalid KMS configuration", ErrKMSUnavailable)
	}
	return &KMSKeyManager{keyID: keyID, client: client}, nil
}

func (m *KMSKeyManager) generate(ctx context.Context, binding EncryptionContext) ([]byte, []byte, string, error) {
	if m == nil || m.client == nil || !binding.valid() {
		return nil, nil, "", ErrKMSUnavailable
	}
	plaintext, ciphertext, resolvedID, err := m.client.GenerateDataKey(ctx, m.keyID, binding.kmsValues())
	if err != nil || len(plaintext) != 32 || len(ciphertext) == 0 || resolvedID != m.keyID {
		Erase(plaintext)
		return nil, nil, "", ErrKMSUnavailable
	}
	return plaintext, append([]byte(nil), ciphertext...), resolvedID, nil
}

func (m *KMSKeyManager) unwrap(ctx context.Context, material EncryptedMaterial, binding EncryptionContext) ([]byte, error) {
	if m == nil || m.client == nil || !binding.valid() || material.KeyID != m.keyID || len(material.EncryptedDataKey) == 0 {
		return nil, ErrKMSUnavailable
	}
	plaintext, err := m.client.DecryptDataKey(ctx, m.keyID, append([]byte(nil), material.EncryptedDataKey...), binding.kmsValues())
	if err != nil || len(plaintext) != 32 {
		Erase(plaintext)
		return nil, ErrKMSUnavailable
	}
	return plaintext, nil
}

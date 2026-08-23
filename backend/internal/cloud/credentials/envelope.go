package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const maxWrappedDataKeyBytes = 16 << 10

// KMSEnvelope applies AES-256-GCM envelope encryption with a fresh KMS data
// key per version. Its only open surface is callback-scoped delivery.
type KMSEnvelope struct{ keys *KMSKeyManager }

func NewKMSEnvelope(keys *KMSKeyManager) (*KMSEnvelope, error) {
	if keys == nil {
		return nil, ErrKMSUnavailable
	}
	return &KMSEnvelope{keys: keys}, nil
}

func (e *KMSEnvelope) Seal(ctx context.Context, plaintext []byte, binding EncryptionContext) (EncryptedMaterial, error) {
	if e == nil || e.keys == nil || !binding.valid() || len(plaintext) == 0 || len(plaintext) > MaxCredentialBytes {
		return EncryptedMaterial{}, ErrKMSUnavailable
	}
	dataKey, encryptedKey, keyID, err := e.keys.Generate(ctx, binding)
	if err != nil {
		return EncryptedMaterial{}, kmsUnavailable(err)
	}
	defer Erase(dataKey)
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return EncryptedMaterial{}, ErrKMSUnavailable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedMaterial{}, ErrKMSUnavailable
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return EncryptedMaterial{}, ErrKMSUnavailable
	}
	return EncryptedMaterial{
		Ciphertext:       aead.Seal(nil, nonce, plaintext, associatedData(binding)),
		EncryptedDataKey: encryptedKey,
		Nonce:            nonce,
		KeyID:            keyID,
	}, nil
}

// Open implements PlaintextOpener. Plaintext and data-key buffers are erased
// before return on every path; callers cannot obtain a general decrypt result.
func (e *KMSEnvelope) Open(ctx context.Context, record CredentialRecord, consume func([]byte) error) error {
	if e == nil || e.keys == nil || consume == nil || !validEncryptedRecord(record) {
		return ErrKMSUnavailable
	}
	binding := recordEncryptionContext(record)
	dataKey, err := e.keys.Unwrap(ctx, record.Material, binding)
	if err != nil {
		return kmsUnavailable(err)
	}
	defer Erase(dataKey)
	block, err := aes.NewCipher(dataKey)
	if err != nil {
		return ErrKMSUnavailable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil || len(record.Material.Nonce) != aead.NonceSize() {
		return ErrInvalid
	}
	plaintext, err := aead.Open(nil, record.Material.Nonce, record.Material.Ciphertext, associatedData(binding))
	if err != nil {
		return errors.New("credential ciphertext authentication failed")
	}
	defer Erase(plaintext)
	if len(plaintext) != int(record.PlaintextBytes) || len(plaintext) > MaxCredentialBytes {
		return ErrInvalid
	}
	return consume(plaintext)
}

func validEncryptedRecord(record CredentialRecord) bool {
	return validIdentifier(record.ID) && validIdentifier(record.OrgID) && validIdentifier(record.OwnerUserID) &&
		record.Provider == ProviderClaudeCode && record.Version > 0 && record.PlaintextBytes > 0 &&
		record.PlaintextBytes <= MaxCredentialBytes && record.RevokedAt.IsZero() &&
		len(record.Material.Ciphertext) > 16 && len(record.Material.Ciphertext) <= MaxCredentialBytes+32 &&
		len(record.Material.EncryptedDataKey) > 0 && len(record.Material.EncryptedDataKey) <= maxWrappedDataKeyBytes &&
		len(record.Material.Nonce) == 12 && validBounded(record.Material.KeyID, maxKMSKeyIDBytes)
}

func recordEncryptionContext(record CredentialRecord) EncryptionContext {
	return EncryptionContext{CredentialID: record.ID, OrgID: record.OrgID, OwnerUserID: record.OwnerUserID, Provider: record.Provider, Version: record.Version}
}

func associatedData(binding EncryptionContext) []byte {
	parts := []string{binding.CredentialID, binding.OrgID, binding.OwnerUserID, string(binding.Provider), fmt.Sprint(binding.Version)}
	result := make([]byte, 0, 128)
	result = append(result, []byte("ao-credential-envelope-v1\x00")...)
	for _, part := range parts {
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(len(part)))
		result = append(result, length[:]...)
		result = append(result, part...)
	}
	return result
}

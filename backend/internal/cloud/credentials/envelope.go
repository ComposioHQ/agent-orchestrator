package credentials

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

// DataKeyManager wraps a production KMS that generates and decrypts data keys.
type DataKeyManager interface {
	GenerateDataKey(context.Context, map[string]string) (plaintext, ciphertext []byte, keyID string, err error)
	DecryptDataKey(context.Context, []byte, map[string]string) ([]byte, error)
}

type KMSEnvelope struct{ keys DataKeyManager }

func NewKMSEnvelope(keys DataKeyManager) (*KMSEnvelope, error) {
	if keys == nil {
		return nil, errors.New("data-key manager is required")
	}
	return &KMSEnvelope{keys: keys}, nil
}

func (e *KMSEnvelope) Encrypt(ctx context.Context, plaintext []byte, encryptionContext map[string]string) (EncryptedMaterial, error) {
	key, encryptedKey, keyID, err := e.keys.GenerateDataKey(ctx, encryptionContext)
	if err != nil {
		return EncryptedMaterial{}, err
	}
	defer Erase(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return EncryptedMaterial{}, fmt.Errorf("construct data cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedMaterial{}, fmt.Errorf("construct data AEAD: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return EncryptedMaterial{}, fmt.Errorf("generate credential nonce: %w", err)
	}
	return EncryptedMaterial{
		Ciphertext:       gcm.Seal(nil, nonce, plaintext, associatedData(encryptionContext)),
		EncryptedDataKey: append([]byte(nil), encryptedKey...),
		Nonce:            nonce,
		KeyID:            keyID,
	}, nil
}

func (e *KMSEnvelope) Decrypt(ctx context.Context, material EncryptedMaterial, encryptionContext map[string]string) ([]byte, error) {
	key, err := e.keys.DecryptDataKey(ctx, material.EncryptedDataKey, encryptionContext)
	if err != nil {
		return nil, err
	}
	defer Erase(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("construct data cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("construct data AEAD: %w", err)
	}
	if len(material.Nonce) != gcm.NonceSize() {
		return nil, errors.New("invalid credential nonce")
	}
	plaintext, err := gcm.Open(nil, material.Nonce, material.Ciphertext, associatedData(encryptionContext))
	if err != nil {
		return nil, errors.New("credential ciphertext authentication failed")
	}
	return plaintext, nil
}

package credentials

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

type memoryKeyManager struct {
	lastPlaintext []byte
	context       map[string]string
}

func (m *memoryKeyManager) GenerateDataKey(_ context.Context, context map[string]string) ([]byte, []byte, string, error) {
	m.context = context
	m.lastPlaintext = bytes.Repeat([]byte{7}, 32)
	return m.lastPlaintext, []byte("kms-ciphertext"), "test-key", nil
}

func (m *memoryKeyManager) DecryptDataKey(_ context.Context, encrypted []byte, context map[string]string) ([]byte, error) {
	if !bytes.Equal(encrypted, []byte("kms-ciphertext")) || context["ao:org-id"] != m.context["ao:org-id"] || context["ao:user-id"] != m.context["ao:user-id"] || context["ao:provider"] != m.context["ao:provider"] {
		return nil, errors.New("encryption context mismatch")
	}
	return bytes.Repeat([]byte{7}, 32), nil
}

func TestKMSEnvelopeRoundTripBindsTenantAndErasesDataKey(t *testing.T) {
	keys := &memoryKeyManager{}
	envelope, err := NewKMSEnvelope(keys)
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte("oauth-secret-that-must-not-be-stored")
	context := map[string]string{"ao:org-id": "org-a", "ao:user-id": "user-a", "ao:provider": ProviderClaudeCode}
	material, err := envelope.Encrypt(contextBackground(), secret, context)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(material.Ciphertext, secret) || bytes.Equal(material.Ciphertext, secret) {
		t.Fatal("ciphertext contains plaintext")
	}
	if !allZero(keys.lastPlaintext) {
		t.Fatal("plaintext data key was not erased after encryption")
	}
	plaintext, err := envelope.Decrypt(contextBackground(), material, context)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plaintext, secret) {
		t.Fatalf("plaintext = %q", plaintext)
	}
	wrong := map[string]string{"ao:org-id": "org-b", "ao:user-id": "user-a", "ao:provider": ProviderClaudeCode}
	if _, err := envelope.Decrypt(contextBackground(), material, wrong); err == nil {
		t.Fatal("cross-tenant decrypt succeeded")
	}
}

func contextBackground() context.Context { return context.Background() }

func allZero(value []byte) bool {
	for _, item := range value {
		if item != 0 {
			return false
		}
	}
	return true
}

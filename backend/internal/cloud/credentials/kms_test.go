package credentials

import (
	"context"
	"errors"
	"testing"
)

func TestKMSIsOptionalAtConstructionButFailsClosedWhenUsed(t *testing.T) {
	store := &fakeCustodyStore{}
	service, err := NewVaultService(store, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Import(testTenantContext(), validImportRequest())
	if !errors.Is(err, ErrKMSUnavailable) || store.puts != 0 {
		t.Fatalf("import error=%v puts=%d", err, store.puts)
	}
	if _, err := NewKMSKeyManager("", &fakeKMSClient{}); !errors.Is(err, ErrKMSUnavailable) {
		t.Fatalf("empty key configuration error = %v", err)
	}
	if _, err := NewKMSKeyManager("kms-key", nil); !errors.Is(err, ErrKMSUnavailable) {
		t.Fatalf("nil client error = %v", err)
	}
}

func TestKMSRejectsWrongKeyAndMalformedDataKeys(t *testing.T) {
	binding := testEncryptionContext()
	client := &fakeKMSClient{resolvedKeyID: "different", generatedKey: make([]byte, 32), encryptedKey: []byte("wrapped")}
	manager, err := NewKMSKeyManager("kms-key", client)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := manager.Generate(context.Background(), binding); !errors.Is(err, ErrKMSUnavailable) {
		t.Fatalf("wrong key id error = %v", err)
	}
	client.resolvedKeyID = "kms-key"
	client.generatedKey = make([]byte, 16)
	if _, _, _, err := manager.Generate(context.Background(), binding); !errors.Is(err, ErrKMSUnavailable) {
		t.Fatalf("short key error = %v", err)
	}
	if _, err := manager.Unwrap(context.Background(), EncryptedMaterial{KeyID: "other", EncryptedDataKey: []byte("wrapped")}, binding); !errors.Is(err, ErrKMSUnavailable) {
		t.Fatalf("material key mismatch error = %v", err)
	}
}

type fakeKMSClient struct {
	generatedKey  []byte
	encryptedKey  []byte
	resolvedKeyID string
	decryptKey    []byte
	err           error
	generateCtx   map[string]string
	decryptCtx    map[string]string
}

func (f *fakeKMSClient) GenerateDataKey(_ context.Context, _ string, values map[string]string) ([]byte, []byte, string, error) {
	f.generateCtx = cloneStrings(values)
	return f.generatedKey, f.encryptedKey, f.resolvedKeyID, f.err
}

func (f *fakeKMSClient) DecryptDataKey(_ context.Context, _ string, _ []byte, values map[string]string) ([]byte, error) {
	f.decryptCtx = cloneStrings(values)
	return f.decryptKey, f.err
}

func cloneStrings(values map[string]string) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func testEncryptionContext() EncryptionContext {
	return EncryptionContext{CredentialID: "credential-1", OrgID: "org-1", OwnerUserID: "user-1", Provider: ProviderClaudeCode, Version: 1}
}

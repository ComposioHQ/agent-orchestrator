package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestVaultImportRotateRevokeUsesCiphertextOnlyStore(t *testing.T) {
	store := &fakeCustodyStore{}
	envelope, _ := testEnvelope(t)
	service, err := NewVaultService(store, envelope)
	if err != nil {
		t.Fatal(err)
	}
	ctx := testTenantContext()
	request := validImportRequest()
	first, err := service.Import(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Provider != ProviderClaudeCode || first.Version != 1 || bytes.Contains(store.record.Material.Ciphertext, []byte("secret-marker")) {
		t.Fatalf("first=%#v stored=%#v", first, store.record)
	}
	firstCiphertext := append([]byte(nil), store.record.Material.Ciphertext...)
	request.Secret = []byte(`{"claudeAiOauth":{"accessToken":"rotated-secret"}}`)
	second, err := service.Rotate(ctx, request)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.Version != 2 || bytes.Equal(firstCiphertext, store.record.Material.Ciphertext) || store.rotations != 1 {
		t.Fatalf("first=%#v second=%#v rotations=%d", first, second, store.rotations)
	}
	if err := service.Revoke(ctx, ProviderClaudeCode); err != nil {
		t.Fatal(err)
	}
	if store.revocations != 1 || store.record.RevokedAt.IsZero() {
		t.Fatalf("revocations=%d revoked=%v", store.revocations, store.record.RevokedAt)
	}
	if _, err := service.Rotate(ctx, request); !errors.Is(err, ErrRevoked) {
		t.Fatalf("rotation after revoke = %v", err)
	}
}

func TestVaultBoundsNameProviderMetadataAndCredential(t *testing.T) {
	envelope, _ := testEnvelope(t)
	service, err := NewVaultService(&fakeCustodyStore{}, envelope)
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*ImportRequest){
		"empty name":     func(request *ImportRequest) { request.Name = "" },
		"oversized name": func(request *ImportRequest) { request.Name = strings.Repeat("x", MaxCredentialNameBytes+1) },
		"wrong provider": func(request *ImportRequest) { request.Provider = Provider("claude") },
		"oversized metadata": func(request *ImportRequest) {
			request.Metadata = json.RawMessage(`{"x":"` + strings.Repeat("x", MaxMetadataBytes) + `"}`)
		},
		"invalid metadata":     func(request *ImportRequest) { request.Metadata = json.RawMessage(`{`) },
		"empty credential":     func(request *ImportRequest) { request.Secret = nil },
		"oversized credential": func(request *ImportRequest) { request.Secret = bytes.Repeat([]byte("x"), MaxCredentialBytes+1) },
		"malformed credential": func(request *ImportRequest) { request.Secret = []byte(`["not-an-object"]`) },
	} {
		t.Run(name, func(t *testing.T) {
			request := validImportRequest()
			mutate(&request)
			if _, err := service.Import(testTenantContext(), request); !errors.Is(err, ErrInvalid) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestVaultRequiresTenantAndReturnsRedactedMetadataOnly(t *testing.T) {
	envelope, _ := testEnvelope(t)
	store := &fakeCustodyStore{}
	service, err := NewVaultService(store, envelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Import(context.Background(), validImportRequest()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("unscoped import = %v", err)
	}
	if _, err := service.List(context.Background()); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("unscoped list = %v", err)
	}
	metadata, err := service.Import(testTenantContext(), validImportRequest())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"secret-marker", "ciphertext", "encryptedDataKey", "nonce", "keyId"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("metadata leaked %q: %s", forbidden, encoded)
		}
	}
}

type fakeCustodyStore struct {
	record                       CredentialRecord
	puts, rotations, revocations int
}

func (f *fakeCustodyStore) PutCredential(_ context.Context, put PutCredential) (CredentialRecord, error) {
	if put.ExpectedVersion == 0 {
		f.puts++
		put.Record.CreatedAt = time.Now()
	} else {
		if f.record.Version != put.ExpectedVersion {
			return CredentialRecord{}, errors.New("version conflict")
		}
		f.rotations++
		put.Record.CreatedAt = f.record.CreatedAt
	}
	put.Record.UpdatedAt = time.Now()
	f.record = cloneRecord(put.Record)
	return cloneRecord(f.record), nil
}

func (f *fakeCustodyStore) ListCredentials(context.Context) ([]Metadata, error) {
	if f.record.ID == "" {
		return []Metadata{}, nil
	}
	return []Metadata{metadataOf(f.record)}, nil
}
func (f *fakeCustodyStore) GetCredential(context.Context, Provider) (CredentialRecord, error) {
	if f.record.ID == "" {
		return CredentialRecord{}, ErrNotFound
	}
	return cloneRecord(f.record), nil
}
func (f *fakeCustodyStore) RevokeCredential(context.Context, Provider) error {
	f.revocations++
	f.record.RevokedAt = time.Now()
	return nil
}

func cloneRecord(record CredentialRecord) CredentialRecord {
	record.Metadata = append(json.RawMessage(nil), record.Metadata...)
	record.Material.Ciphertext = append([]byte(nil), record.Material.Ciphertext...)
	record.Material.EncryptedDataKey = append([]byte(nil), record.Material.EncryptedDataKey...)
	record.Material.Nonce = append([]byte(nil), record.Material.Nonce...)
	return record
}

func validImportRequest() ImportRequest {
	return ImportRequest{Name: "Claude Code", Provider: ProviderClaudeCode, Metadata: json.RawMessage(`{"source":"keychain"}`), Secret: append([]byte(nil), testSecret...)}
}

func testTenantContext() context.Context {
	return tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1", Role: "owner"})
}

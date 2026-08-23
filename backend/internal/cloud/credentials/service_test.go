package credentials

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type memoryStore struct {
	record *Record
	audits []string
}

func (s *memoryStore) Put(_ context.Context, provider, credentialType string, material EncryptedMaterial) (Record, error) {
	now := time.Now().UTC()
	version := int64(1)
	created := now
	if s.record != nil {
		version = s.record.Version + 1
		created = s.record.CreatedAt
	}
	record := Record{ID: "credential-1", OrgID: "org-1", OwnerUserID: "user-1", Provider: provider, CredentialType: credentialType, Material: material, Version: version, CreatedAt: created, UpdatedAt: now}
	s.record = &record
	if version == 1 {
		s.audits = append(s.audits, "credential.created")
	} else {
		s.audits = append(s.audits, "credential.rotated")
	}
	return record, nil
}

func (s *memoryStore) List(context.Context) ([]Metadata, error) {
	if s.record == nil {
		return []Metadata{}, nil
	}
	return []Metadata{metadata(*s.record)}, nil
}

func (s *memoryStore) Get(_ context.Context, provider string) (Record, error) {
	if s.record == nil || s.record.Provider != provider {
		return Record{}, ErrNotFound
	}
	return *s.record, nil
}

func (s *memoryStore) GetForWorkspace(_ context.Context, orgID, _ string, provider, _ string) (Record, error) {
	if orgID != "org-1" {
		return Record{}, ErrNotFound
	}
	s.audits = append(s.audits, "credential.decrypted")
	return s.Get(context.Background(), provider)
}

func (s *memoryStore) Delete(_ context.Context, provider string) error {
	if s.record == nil || s.record.Provider != provider {
		return ErrNotFound
	}
	s.record = nil
	s.audits = append(s.audits, "credential.revoked")
	return nil
}

func (s *memoryStore) Audit(_ context.Context, _ string, _ string, event string, _ int64) error {
	s.audits = append(s.audits, event)
	return nil
}

func (s *memoryStore) AuditWorkspace(_ context.Context, _, _, _, _, event string, _ int64) error {
	s.audits = append(s.audits, event)
	return nil
}

func TestServiceRotationRevocationAuditAndRedaction(t *testing.T) {
	store := &memoryStore{}
	keys := &memoryKeyManager{}
	envelope, _ := NewKMSEnvelope(keys)
	service, _ := NewService(store, envelope)
	ctx := tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1", Role: "owner"})

	first := claudeSecret("first-secret")
	created, err := service.Put(ctx, ProviderClaudeCode, TypeOAuthToken, first)
	if err != nil {
		t.Fatal(err)
	}
	second := claudeSecret("rotated-secret")
	rotated, err := service.Put(ctx, ProviderClaudeCode, TypeOAuthToken, second)
	if err != nil {
		t.Fatal(err)
	}
	if created.Version != 1 || rotated.Version != 2 {
		t.Fatalf("versions = %d, %d", created.Version, rotated.Version)
	}
	encoded, err := json.Marshal(rotated)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("rotated-secret")) || bytes.Contains(encoded, []byte("ciphertext")) {
		t.Fatalf("redacted metadata exposed secret material: %s", encoded)
	}
	plaintext, credentialType, err := service.Decrypt(ctx, ProviderClaudeCode)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plaintext, second) || credentialType != TypeOAuthToken {
		t.Fatalf("decrypted = %q, %q", plaintext, credentialType)
	}
	Erase(plaintext)
	if !allZero(plaintext) {
		t.Fatal("caller could not erase transient plaintext")
	}
	if err := service.Delete(ctx, ProviderClaudeCode); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.Decrypt(ctx, ProviderClaudeCode); !errors.Is(err, ErrNotFound) {
		t.Fatalf("decrypt after revoke = %v", err)
	}
	wantAudit := []string{"credential.created", "credential.rotated", "credential.decrypted", "credential.revoked"}
	if !equalStrings(store.audits, wantAudit) {
		t.Fatalf("audit = %#v, want %#v", store.audits, wantAudit)
	}
}

func TestServiceFailsClosedWithoutTenantAndRejectsUnsupportedProvider(t *testing.T) {
	store := &memoryStore{}
	envelope, _ := NewKMSEnvelope(&memoryKeyManager{})
	service, _ := NewService(store, envelope)
	if _, err := service.Put(context.Background(), ProviderClaudeCode, TypeOAuthToken, claudeSecret("secret")); !errors.Is(err, tenant.ErrNoTenant) {
		t.Fatalf("unscoped put = %v", err)
	}
	ctx := tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: "org", UserID: "user"})
	if _, err := service.Put(ctx, "unknown", TypeOAuthToken, claudeSecret("secret")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unsupported provider = %v", err)
	}
}

type recordingSecretSink struct {
	names    []string
	modes    []fs.FileMode
	snapshot []byte
	received []byte
	purged   bool
	err      error
}

func (s *recordingSecretSink) Deliver(name string, content []byte, mode fs.FileMode) (string, error) {
	s.names = append(s.names, name)
	s.modes = append(s.modes, mode)
	s.snapshot = append([]byte(nil), content...)
	s.received = content
	return "/home/agent/.claude/" + name, s.err
}

func (s *recordingSecretSink) Purge() error {
	s.purged = true
	return nil
}

func TestDeliverToSandboxUses0600FileErasesBytesAndAuditsLifecycle(t *testing.T) {
	store := &memoryStore{}
	envelope, _ := NewKMSEnvelope(&memoryKeyManager{})
	service, _ := NewService(store, envelope)
	ctx := tenant.WithIdentity(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	secret := claudeSecret("sandbox-secret")
	if _, err := service.Put(ctx, ProviderClaudeCode, TypeOAuthToken, secret); err != nil {
		t.Fatal(err)
	}
	sink := &recordingSecretSink{}
	cleanup, err := service.MaterializeForSandbox(context.Background(), BootstrapScope{OrgID: "org-1", WorkspaceID: "workspace-1", SandboxID: "sandbox-1", Harness: HarnessClaudeCode}, sink)
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.names) != 1 || sink.names[0] != ".credentials.json" || sink.modes[0] != 0o600 {
		t.Fatalf("delivered = names %#v, modes %#v", sink.names, sink.modes)
	}
	if !bytes.Contains(sink.snapshot, []byte("sandbox-secret")) {
		t.Fatal("sandbox did not receive credential")
	}
	if !allZero(sink.received) {
		t.Fatal("control-plane file buffer was not erased after delivery")
	}
	if sink.purged {
		t.Fatal("credential file was purged before the harness could consume it")
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if !sink.purged {
		t.Fatal("credential file was not purged after bootstrap")
	}
	want := []string{"credential.created", "credential.decrypted", "credential.materialized", "credential.purged"}
	if !equalStrings(store.audits, want) {
		t.Fatalf("audit = %#v, want %#v", store.audits, want)
	}
}

func claudeSecret(token string) []byte {
	return []byte(`{"claudeAiOauth":{"accessToken":"` + token + `","refreshToken":"refresh"}}`)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

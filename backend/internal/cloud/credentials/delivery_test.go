package credentials

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

func TestDeliverBootstrapUsesAuthorizedRemoteSinkThenPurgesAndZeros(t *testing.T) {
	key := bytes.Repeat([]byte{0x42}, 32)
	secret := []byte(`{"claudeAiOauth":{"accessToken":"claude-secret","refreshToken":"refresh-secret"}}`)
	record := bootstrapRecord(t, key, secret)
	store := &recordingStore{record: record, expected: authorizationFor(record)}
	keys := &recordingUnwrapper{key: append([]byte(nil), key...)}
	sink := &recordingSink{}
	service := newDeliveryService(t, store, keys, nil)

	err := service.DeliverBootstrap(context.Background(), verifiedFor(record), ProviderClaude, sink)
	if err != nil {
		t.Fatal(err)
	}
	if sink.sandboxID != "sandbox-provider-1" {
		t.Fatalf("remote sandbox = %q", sink.sandboxID)
	}
	if len(sink.paths) != 1 || sink.paths[0] != ".claude/.credentials.json" || sink.modes[0] != 0o600 {
		t.Fatalf("remote files = paths %#v, modes %#v", sink.paths, sink.modes)
	}
	if !bytes.Equal(sink.snapshot, secret) {
		t.Fatalf("delivered plaintext = %q", sink.snapshot)
	}
	if !allZero(sink.retained) {
		t.Fatal("control-plane plaintext buffer was not zeroed")
	}
	if !allZero(keys.returned) {
		t.Fatal("plaintext KMS data key was not zeroed")
	}
	if !sink.purged {
		t.Fatal("remote credential file was not purged")
	}
	wantEvents := []BootstrapEvent{EventMaterialized, EventPurged}
	if !reflect.DeepEqual(store.events, wantEvents) {
		t.Fatalf("audit events = %#v, want %#v", store.events, wantEvents)
	}
}

func TestDeliverBootstrapRejectsForgedCapabilityRelationships(t *testing.T) {
	key := bytes.Repeat([]byte{0x24}, 32)
	record := bootstrapRecord(t, key, []byte(`{"claudeAiOauth":{"accessToken":"secret-token"}}`))
	valid := verifiedFor(record)
	tests := []struct {
		name   string
		mutate func(*capability.Verified)
	}{
		{"organization", func(v *capability.Verified) { v.Scope.OrgID = "org-forged" }},
		{"workspace", func(v *capability.Verified) { v.Scope.WorkspaceID = "workspace-forged" }},
		{"session", func(v *capability.Verified) { v.Scope.SessionID = "session-forged" }},
		{"grant", func(v *capability.Verified) { v.ID = "grant-forged" }},
		{"role", func(v *capability.Verified) { v.Scope.Role = capability.RoleCoordinator }},
		{"operation", func(v *capability.Verified) { v.Scope.Operations = []capability.Operation{capability.OpSessionRead} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			presented := valid
			presented.Scope.Operations = append([]capability.Operation(nil), valid.Scope.Operations...)
			test.mutate(&presented)
			store := &recordingStore{record: record, expected: authorizationFor(record)}
			sink := &recordingSink{}
			service := newDeliveryService(t, store, &recordingUnwrapper{key: append([]byte(nil), key...)}, nil)
			err := service.DeliverBootstrap(context.Background(), presented, ProviderClaude, sink)
			if !errors.Is(err, ErrNotAuthorized) {
				t.Fatalf("forged %s scope = %v", test.name, err)
			}
			if sink.deliverCalls != 0 || sink.purgeCalls != 0 {
				t.Fatal("remote sink called for forged authorization")
			}
		})
	}
}

func TestDeliverBootstrapRejectsUnboundRuntimeAndSandbox(t *testing.T) {
	key := bytes.Repeat([]byte{0x31}, 32)
	record := bootstrapRecord(t, key, []byte(`{"claudeAiOauth":{"accessToken":"secret-token"}}`))
	store := &recordingStore{resolveErr: ErrNotAuthorized}
	sink := &recordingSink{}
	service := newDeliveryService(t, store, &recordingUnwrapper{key: key}, nil)

	err := service.DeliverBootstrap(context.Background(), verifiedFor(record), ProviderClaude, sink)
	if !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("unbound runtime/sandbox = %v", err)
	}
	if sink.deliverCalls != 0 || sink.purgeCalls != 0 {
		t.Fatal("remote sink called for an unbound runtime/sandbox")
	}
}

func TestDeliverBootstrapRejectsStoreResultOutsideVerifiedScope(t *testing.T) {
	key := bytes.Repeat([]byte{0x61}, 32)
	record := bootstrapRecord(t, key, []byte(`{"claudeAiOauth":{"accessToken":"secret-token"}}`))
	verified := verifiedFor(record)
	record.SandboxID = "sandbox-from-different-runtime"
	record.WorkspaceID = "workspace-from-different-org"
	store := &recordingStore{record: record, expected: BootstrapAuthorization{
		GrantID: verified.ID, Scope: verified.Scope, Provider: ProviderClaude,
	}}
	sink := &recordingSink{}
	service := newDeliveryService(t, store, &recordingUnwrapper{key: key}, nil)

	err := service.DeliverBootstrap(context.Background(), verified, ProviderClaude, sink)
	if !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("cross-scope store result = %v", err)
	}
	if sink.deliverCalls != 0 || sink.purgeCalls != 0 {
		t.Fatal("remote sink called with cross-scope store result")
	}
}

func TestDeliverBootstrapFailsClosedWhenKMSDisabledOrMisconfigured(t *testing.T) {
	key := bytes.Repeat([]byte{0x18}, 32)
	record := bootstrapRecord(t, key, []byte(`{"claudeAiOauth":{"accessToken":"secret-token"}}`))
	tests := []struct {
		name string
		keys DataKeyUnwrapper
	}{
		{"optional vault disabled", nil},
		{"KMS misconfigured", &recordingUnwrapper{err: errors.New("unknown KMS key")}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := &recordingStore{record: record, expected: authorizationFor(record)}
			sink := &recordingSink{}
			service := newDeliveryService(t, store, test.keys, nil)
			err := service.DeliverBootstrap(context.Background(), verifiedFor(record), ProviderClaude, sink)
			if !errors.Is(err, ErrKMSUnavailable) {
				t.Fatalf("credential operation = %v", err)
			}
			if sink.deliverCalls != 0 || sink.purgeCalls != 0 {
				t.Fatal("remote sink called without working KMS")
			}
		})
	}
}

func TestDeliverBootstrapPurgesAfterPartialRemoteFailure(t *testing.T) {
	key := bytes.Repeat([]byte{0x53}, 32)
	record := bootstrapRecord(t, key, []byte(`{"claudeAiOauth":{"accessToken":"secret-token"}}`))
	store := &recordingStore{record: record, expected: authorizationFor(record)}
	sink := &recordingSink{deliverErr: errors.New("transport interrupted")}
	service := newDeliveryService(t, store, &recordingUnwrapper{key: append([]byte(nil), key...)}, nil)

	err := service.DeliverBootstrap(context.Background(), verifiedFor(record), ProviderClaude, sink)
	if err == nil || !strings.Contains(err.Error(), "transport interrupted") {
		t.Fatalf("delivery failure = %v", err)
	}
	if !sink.purged || !allZero(sink.retained) {
		t.Fatal("partial delivery was not remotely purged and locally zeroed")
	}
	wantEvents := []BootstrapEvent{EventDeliveryFailed, EventPurged}
	if !reflect.DeepEqual(store.events, wantEvents) {
		t.Fatalf("audit events = %#v, want %#v", store.events, wantEvents)
	}
}

func TestEncryptedMaterialAndMetadataAreRedacted(t *testing.T) {
	material := EncryptedMaterial{
		Ciphertext:       []byte("ciphertext-secret"),
		EncryptedDataKey: []byte("wrapped-key-secret"),
		Nonce:            []byte("nonce-secret"),
		KeyID:            "kms-key-secret",
	}
	encoded, err := json.Marshal(material)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"ciphertext-secret", "wrapped-key-secret", "nonce-secret", "kms-key-secret"} {
		if bytes.Contains(encoded, []byte(forbidden)) || strings.Contains(fmt.Sprint(material), forbidden) {
			t.Fatalf("secret material %q was not redacted", forbidden)
		}
	}
}

func newDeliveryService(t *testing.T, store BootstrapStore, keys DataKeyUnwrapper, registry *ProviderRegistry) *DeliveryService {
	t.Helper()
	service, err := NewDeliveryService(store, keys, registry)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func verifiedFor(record BootstrapRecord) capability.Verified {
	return capability.Verified{ID: "grant-1", Scope: capability.Scope{
		OrgID: record.OrgID, WorkspaceID: record.WorkspaceID, SessionID: record.SessionID,
		Role: record.Role, Operations: []capability.Operation{capability.OpHarnessCredentialBootstrap},
	}}
}

func authorizationFor(record BootstrapRecord) BootstrapAuthorization {
	verified := verifiedFor(record)
	return BootstrapAuthorization{GrantID: verified.ID, Scope: verified.Scope, Provider: record.Provider}
}

func bootstrapRecord(t *testing.T, key, plaintext []byte) BootstrapRecord {
	t.Helper()
	record := BootstrapRecord{
		CredentialID: "credential-1", Provider: ProviderClaude, Version: 3,
		OrgID: "org-1", WorkspaceID: "workspace-1", SessionID: "session-1",
		Role: capability.RoleWorker, SandboxID: "sandbox-provider-1",
	}
	ctx := EncryptionContext{CredentialID: record.CredentialID, OrgID: record.OrgID, Provider: record.Provider, Version: record.Version}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{0x07}, aead.NonceSize())
	record.Material = EncryptedMaterial{
		Ciphertext:       aead.Seal(nil, nonce, plaintext, ctx.additionalData()),
		EncryptedDataKey: []byte("wrapped-data-key"), Nonce: nonce, KeyID: "kms-key-1",
	}
	return record
}

type recordingStore struct {
	record     BootstrapRecord
	expected   BootstrapAuthorization
	resolveErr error
	events     []BootstrapEvent
}

func (s *recordingStore) ResolveBootstrap(_ context.Context, auth BootstrapAuthorization) (BootstrapRecord, error) {
	if s.resolveErr != nil {
		return BootstrapRecord{}, s.resolveErr
	}
	if !reflect.DeepEqual(auth, s.expected) {
		return BootstrapRecord{}, ErrNotAuthorized
	}
	return s.record, nil
}

func (s *recordingStore) RecordBootstrapEvent(_ context.Context, _ BootstrapRecord, event BootstrapEvent) error {
	s.events = append(s.events, event)
	return nil
}

type recordingUnwrapper struct {
	key      []byte
	returned []byte
	err      error
}

func (u *recordingUnwrapper) UnwrapDataKey(context.Context, []byte, EncryptionContext) ([]byte, error) {
	if u.err != nil {
		return nil, u.err
	}
	u.returned = u.key
	return u.returned, nil
}

type recordingSink struct {
	deliverCalls int
	purgeCalls   int
	sandboxID    string
	paths        []string
	modes        []fs.FileMode
	snapshot     []byte
	retained     []byte
	purged       bool
	deliverErr   error
}

func (s *recordingSink) DeliverSecretFiles(_ context.Context, sandboxID string, files []SecretFile) error {
	s.deliverCalls++
	s.sandboxID = sandboxID
	for _, file := range files {
		s.paths = append(s.paths, file.Path)
		s.modes = append(s.modes, file.Mode)
		s.snapshot = append([]byte(nil), file.Content...)
		s.retained = file.Content
	}
	return s.deliverErr
}

func (s *recordingSink) PurgeSecretFiles(_ context.Context, sandboxID string, paths []string) error {
	s.purgeCalls++
	if sandboxID != s.sandboxID {
		return errors.New("purge targeted a different sandbox")
	}
	s.purged = true
	return nil
}

func allZero(value []byte) bool {
	for _, item := range value {
		if item != 0 {
			return false
		}
	}
	return true
}

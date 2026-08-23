package credentials

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestEnvelopeRoundTripBindsContextAndZerosKeysAndPlaintext(t *testing.T) {
	generatedKey := bytes.Repeat([]byte{7}, 32)
	client := &fakeKMSClient{generatedKey: generatedKey, encryptedKey: []byte("wrapped-key"), resolvedKeyID: "kms-key"}
	manager, err := NewKMSKeyManager("kms-key", client)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := NewKMSEnvelope(manager)
	if err != nil {
		t.Fatal(err)
	}
	secret := append([]byte(nil), testSecret...)
	binding := testEncryptionContext()
	material, err := envelope.seal(context.Background(), secret, binding)
	if err != nil {
		t.Fatal(err)
	}
	if !isZero(generatedKey) {
		t.Fatal("generated plaintext data key was not zeroed")
	}
	if bytes.Contains(material.Ciphertext, []byte("secret-marker")) {
		t.Fatal("ciphertext contains plaintext marker")
	}
	client.decryptKey = bytes.Repeat([]byte{7}, 32)
	decryptKey := client.decryptKey
	record := CredentialRecord{ID: binding.CredentialID, OrgID: binding.OrgID, OwnerUserID: binding.OwnerUserID,
		Provider: binding.Provider, Version: binding.Version, PlaintextBytes: int64(len(secret)), Material: material}
	var observed []byte
	err = envelope.Open(context.Background(), record, func(plaintext []byte) error {
		observed = plaintext
		if !bytes.Equal(plaintext, secret) {
			t.Fatalf("plaintext mismatch")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !isZero(observed) || !isZero(decryptKey) {
		t.Fatal("opened plaintext or unwrapped data key was not zeroed")
	}
	if client.generateCtx["ao:org-id"] != "org-1" || client.decryptCtx["ao:credential-id"] != "credential-1" {
		t.Fatalf("KMS contexts not bound: %#v %#v", client.generateCtx, client.decryptCtx)
	}
}

func TestEnvelopeRejectsMovedCiphertextAndErasesOnConsumerFailure(t *testing.T) {
	envelope, client := testEnvelope(t)
	secret := append([]byte(nil), testSecret...)
	binding := testEncryptionContext()
	material, err := envelope.seal(context.Background(), secret, binding)
	if err != nil {
		t.Fatal(err)
	}
	client.decryptKey = bytes.Repeat([]byte{9}, 32)
	moved := CredentialRecord{ID: binding.CredentialID, OrgID: "other-org", OwnerUserID: binding.OwnerUserID,
		Provider: binding.Provider, Version: 1, PlaintextBytes: int64(len(secret)), Material: material}
	if err := envelope.Open(context.Background(), moved, func([]byte) error { return nil }); err == nil {
		t.Fatal("ciphertext moved across org opened")
	}

	client.decryptKey = bytes.Repeat([]byte{9}, 32)
	record := moved
	record.OrgID = binding.OrgID
	var observed []byte
	want := errors.New("consumer failed")
	err = envelope.Open(context.Background(), record, func(plaintext []byte) error { observed = plaintext; return want })
	if !errors.Is(err, want) || !isZero(observed) {
		t.Fatalf("error=%v zero=%v", err, isZero(observed))
	}
}

func testEnvelope(t *testing.T) (*KMSEnvelope, *fakeKMSClient) {
	t.Helper()
	client := &fakeKMSClient{generatedKey: bytes.Repeat([]byte{9}, 32), encryptedKey: []byte("wrapped-key"), resolvedKeyID: "kms-key"}
	manager, err := NewKMSKeyManager("kms-key", client)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := NewKMSEnvelope(manager)
	if err != nil {
		t.Fatal(err)
	}
	return envelope, client
}

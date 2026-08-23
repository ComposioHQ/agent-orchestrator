package credentials

import (
	"bytes"
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

type kmsSpy struct {
	generated *kms.GenerateDataKeyInput
	decrypted *kms.DecryptInput
}

func (s *kmsSpy) GenerateDataKey(_ context.Context, input *kms.GenerateDataKeyInput, _ ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error) {
	s.generated = input
	return &kms.GenerateDataKeyOutput{Plaintext: bytes.Repeat([]byte{9}, 32), CiphertextBlob: []byte("wrapped"), KeyId: aws.String("kms-key")}, nil
}

func (s *kmsSpy) Decrypt(_ context.Context, input *kms.DecryptInput, _ ...func(*kms.Options)) (*kms.DecryptOutput, error) {
	s.decrypted = input
	return &kms.DecryptOutput{Plaintext: bytes.Repeat([]byte{9}, 32)}, nil
}

func TestAWSKeyManagerPinsKeyAndEncryptionContext(t *testing.T) {
	api := &kmsSpy{}
	manager, err := NewAWSKeyManager(api, "kms-key")
	if err != nil {
		t.Fatal(err)
	}
	context := map[string]string{"ao:org-id": "org", "ao:user-id": "user", "ao:provider": "claude-code"}
	plaintext, wrapped, _, err := manager.GenerateDataKey(contextBackground(), context)
	if err != nil {
		t.Fatal(err)
	}
	Erase(plaintext)
	if aws.ToString(api.generated.KeyId) != "kms-key" || api.generated.EncryptionContext["ao:org-id"] != "org" {
		t.Fatalf("GenerateDataKey input = %#v", api.generated)
	}
	key, err := manager.DecryptDataKey(contextBackground(), wrapped, context)
	if err != nil {
		t.Fatal(err)
	}
	Erase(key)
	if aws.ToString(api.decrypted.KeyId) != "kms-key" || api.decrypted.EncryptionContext["ao:user-id"] != "user" {
		t.Fatalf("Decrypt input = %#v", api.decrypted)
	}
}

package credentials

import (
	"context"
	"errors"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/kms/types"
)

type kmsAPI interface {
	GenerateDataKey(context.Context, *kms.GenerateDataKeyInput, ...func(*kms.Options)) (*kms.GenerateDataKeyOutput, error)
	Decrypt(context.Context, *kms.DecryptInput, ...func(*kms.Options)) (*kms.DecryptOutput, error)
}

// AWSKeyManager is the production KMS data-key boundary. The KMS encryption
// context binds a wrapped key to exactly one organization, owner, and harness.
type AWSKeyManager struct {
	client kmsAPI
	keyID  string
}

func NewAWSKeyManager(client kmsAPI, keyID string) (*AWSKeyManager, error) {
	keyID = strings.TrimSpace(keyID)
	if client == nil || keyID == "" {
		return nil, errors.New("AWS KMS client and credential key id are required")
	}
	return &AWSKeyManager{client: client, keyID: keyID}, nil
}

func (m *AWSKeyManager) GenerateDataKey(ctx context.Context, encryptionContext map[string]string) ([]byte, []byte, string, error) {
	output, err := m.client.GenerateDataKey(ctx, &kms.GenerateDataKeyInput{
		KeyId:             aws.String(m.keyID),
		KeySpec:           types.DataKeySpecAes256,
		EncryptionContext: encryptionContext,
	})
	if err != nil {
		return nil, nil, "", err
	}
	if len(output.Plaintext) != 32 || len(output.CiphertextBlob) == 0 {
		Erase(output.Plaintext)
		return nil, nil, "", errors.New("AWS KMS returned an invalid data key")
	}
	return output.Plaintext, output.CiphertextBlob, aws.ToString(output.KeyId), nil
}

func (m *AWSKeyManager) DecryptDataKey(ctx context.Context, encrypted []byte, encryptionContext map[string]string) ([]byte, error) {
	output, err := m.client.Decrypt(ctx, &kms.DecryptInput{
		KeyId:             aws.String(m.keyID),
		CiphertextBlob:    encrypted,
		EncryptionContext: encryptionContext,
	})
	if err != nil {
		return nil, err
	}
	if len(output.Plaintext) != 32 {
		Erase(output.Plaintext)
		return nil, errors.New("AWS KMS returned an invalid plaintext data key")
	}
	return output.Plaintext, nil
}

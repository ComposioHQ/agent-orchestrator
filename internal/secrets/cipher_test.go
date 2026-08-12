package secrets

import (
	"bytes"
	"testing"
)

func TestCipherRoundTripAndAssociatedData(t *testing.T) {
	t.Parallel()
	cipher, err := New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, nonce, err := cipher.Encrypt([]byte("provider-secret"), "org|provider")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte("provider-secret")) {
		t.Fatal("ciphertext contains plaintext")
	}
	plaintext, err := cipher.Decrypt(encrypted, nonce, "org|provider")
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != "provider-secret" {
		t.Fatalf("plaintext = %q", plaintext)
	}
	if _, err := cipher.Decrypt(encrypted, nonce, "other-org|provider"); err == nil {
		t.Fatal("decrypt succeeded with different associated data")
	}
}

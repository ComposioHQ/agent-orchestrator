package githubapp

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestWebhookVerification(t *testing.T) {
	body := []byte(`{"action":"created"}`)
	mac := hmac.New(sha256.New, []byte("webhook-secret"))
	_, _ = mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !VerifyWebhook("webhook-secret", body, signature) {
		t.Fatal("valid GitHub webhook signature was rejected")
	}
	if VerifyWebhook("webhook-secret", []byte(`{"action":"deleted"}`), signature) {
		t.Fatal("tampered GitHub webhook payload was accepted")
	}
	if VerifyWebhook("webhook-secret", body, "sha1=bad") {
		t.Fatal("unsupported GitHub webhook signature was accepted")
	}
}

func TestEncryptedPKCEVerifierIsBoundToInstallation(t *testing.T) {
	key := make([]byte, 32)
	verifier, challenge, err := NewPKCE()
	if err != nil {
		t.Fatal(err)
	}
	if verifier == "" || challenge == "" || verifier == challenge {
		t.Fatalf("invalid PKCE pair: verifier=%q challenge=%q", verifier, challenge)
	}
	ciphertext, nonce, err := Encrypt(
		key,
		[]byte(verifier),
		[]byte("installation-123"),
	)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := Decrypt(
		key,
		ciphertext,
		nonce,
		[]byte("installation-123"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(decrypted) != verifier {
		t.Fatalf("decrypted verifier = %q, want %q", decrypted, verifier)
	}
	if _, err := Decrypt(
		key,
		ciphertext,
		nonce,
		[]byte("installation-456"),
	); err == nil {
		t.Fatal("encrypted verifier was accepted for another installation")
	}
}

func TestStateHashesDoNotExposeState(t *testing.T) {
	state, hash, err := NewState()
	if err != nil {
		t.Fatal(err)
	}
	if len(hash) != sha256.Size {
		t.Fatalf("state hash length = %d, want %d", len(hash), sha256.Size)
	}
	if string(hash) == state {
		t.Fatal("state was stored in plaintext")
	}
	if string(HashState(state)) != string(hash) {
		t.Fatal("state hash is not stable")
	}
}

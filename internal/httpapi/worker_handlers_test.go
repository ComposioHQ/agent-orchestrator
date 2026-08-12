package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/secrets"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

type workerHandlerStore struct {
	Store
	credential domain.WorkerCredential
}

func (s workerHandlerStore) WorkerAgentCredential(
	context.Context,
	string,
	string,
	string,
	int64,
) (domain.WorkerCredential, error) {
	return s.credential, nil
}

func TestWorkerEventAllowlistIsExact(t *testing.T) {
	for _, eventType := range []string{"worker.ready", "chat.assistant_delta"} {
		if !allowedWorkerEventType(eventType) {
			t.Fatalf("%q should be allowed", eventType)
		}
	}
	for _, eventType := range []string{
		"worker.connected",
		"chat.turn_completed",
		"terminal.output",
		"billing.credit",
		"chat.assistant_delta.extra",
	} {
		if allowedWorkerEventType(eventType) {
			t.Fatalf("%q should be denied", eventType)
		}
	}
}

func TestWorkerCredentialIsDecryptedWithNoStore(t *testing.T) {
	cipher, err := secrets.New(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	encrypted, nonce, err := cipher.Encrypt(
		[]byte("credential-secret"),
		providerSecretAssociatedData("org-1", "claude-code"),
	)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{
		store: workerHandlerStore{credential: domain.WorkerCredential{
			Provider:        "claude-code",
			CredentialType:  "api_key",
			EncryptedSecret: encrypted,
			Nonce:           nonce,
		}},
		secretCipher: cipher,
	}
	request := httptest.NewRequest(http.MethodGet, "/worker/credential", nil)
	request = request.WithContext(context.WithValue(
		request.Context(),
		workerContextKey{},
		worker.Claims{
			OrgID: "org-1", SessionID: "session-1", WorkerID: "worker-1",
			Epoch: 1, Scopes: []string{"worker:credential:read"},
		},
	))
	response := httptest.NewRecorder()
	server.workerCredential(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	var body worker.CredentialResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Secret != "credential-secret" || body.Provider != "claude-code" {
		t.Fatalf("credential response = %#v", body)
	}
}

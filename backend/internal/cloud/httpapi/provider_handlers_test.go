package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/secrets"
	"github.com/go-chi/chi/v5"
)

type promotionStore struct {
	Store
	encrypted  []byte
	nonce      []byte
	config     json.RawMessage
	saved      domain.UserProviderConnection
	savedData  []byte
	savedNonce []byte
}

func (s *promotionStore) ProviderConnectionSecretForPromotion(
	context.Context, domain.Principal, string, string, string,
) ([]byte, []byte, json.RawMessage, error) {
	return s.encrypted, s.nonce, s.config, nil
}

func (*promotionStore) UserAgentCredentialAvailable(context.Context, string, string) (bool, error) {
	return false, nil
}

func (*promotionStore) ListUserProviderConnections(context.Context, domain.Principal) ([]domain.UserProviderConnection, error) {
	return nil, nil
}

func (s *promotionStore) UpsertUserProviderConnection(
	_ context.Context,
	principal domain.Principal,
	provider, label string,
	encrypted, nonce []byte,
	config json.RawMessage,
) (domain.UserProviderConnection, error) {
	s.savedData = append([]byte(nil), encrypted...)
	s.savedNonce = append([]byte(nil), nonce...)
	s.saved = domain.UserProviderConnection{
		ID: "personal-1", UserID: principal.UserID, Provider: provider, Label: label,
		Config: config, ValidationState: "valid", CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	return s.saved, nil
}

func TestPromoteAgentConnectionRewrapsTheSecretForTheUser(t *testing.T) {
	cipher, err := secrets.New(bytes.Repeat([]byte{6}, 32))
	if err != nil {
		t.Fatal(err)
	}
	orgID := "11111111-1111-1111-1111-111111111111"
	encrypted, nonce, err := cipher.Encrypt(
		[]byte("legacy-secret"), providerSecretAssociatedData(orgID, "claude-code"),
	)
	if err != nil {
		t.Fatal(err)
	}
	store := &promotionStore{
		encrypted: encrypted,
		nonce:     nonce,
		config:    json.RawMessage(`{"credentialType":"api_key"}`),
	}
	server := &Server{store: store, secretCipher: cipher}
	request := httptest.NewRequest(http.MethodPost, "/promote", nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("orgId", orgID)
	route.URLParams.Add("agent", "claude-code")
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
	ctx = context.WithValue(ctx, principalKey, domain.Principal{UserID: "22222222-2222-2222-2222-222222222222"})
	request = request.WithContext(ctx)
	response := httptest.NewRecorder()

	server.promoteAgentConnection(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	plaintext, err := cipher.Decrypt(
		store.savedData,
		store.savedNonce,
		providerSecretAssociatedData("user:22222222-2222-2222-2222-222222222222", "claude-code"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != "legacy-secret" {
		t.Fatalf("promoted secret = %q", plaintext)
	}
}

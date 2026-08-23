package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type credentialVaultSpy struct {
	items       []credentials.Metadata
	secret      []byte
	seen        tenant.Identity
	deleted     string
	putCalls    int
	listCalls   int
	deleteCalls int
}

func (v *credentialVaultSpy) Put(ctx context.Context, provider, credentialType string, secret []byte) (credentials.Metadata, error) {
	v.seen, _ = tenant.FromContext(ctx)
	v.secret = secret
	v.putCalls++
	now := time.Now().UTC()
	item := credentials.Metadata{ID: "cred-1", Provider: provider, CredentialType: credentialType, Version: 1, CreatedAt: now, UpdatedAt: now}
	v.items = []credentials.Metadata{item}
	return item, nil
}

func (v *credentialVaultSpy) List(ctx context.Context) ([]credentials.Metadata, error) {
	v.seen, _ = tenant.FromContext(ctx)
	v.listCalls++
	return v.items, nil
}

func (v *credentialVaultSpy) Delete(ctx context.Context, provider string) error {
	v.seen, _ = tenant.FromContext(ctx)
	v.deleted = provider
	v.deleteCalls++
	return nil
}

func newCredentialServer(t *testing.T, vault CredentialVault) *Server {
	t.Helper()
	principal := domain.Principal{UserID: "58fc7182-0360-412f-abd9-5057097db664", Email: "person@example.com", Provider: "google", ExternalID: "google-subject"}
	store := &memoryAccountStore{
		principal:   principal,
		memberships: []domain.Membership{{OrgID: orgOneID, OrgSlug: orgOneSlug, Role: "owner"}},
		refreshes:   make(map[string]string),
	}
	tokens, err := auth.NewAccessTokenManager([]byte("0123456789abcdef0123456789abcdef"), "test", "test", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(Options{
		Store: store, Google: &staticIdentityVerifier{principal: principal}, AllowedEmails: []string{"person@example.com"},
		AccessTokens: tokens, RefreshTokenTTL: time.Hour, Credentials: vault,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return server
}

func TestCredentialRoutesAuthenticateScopeRedactAndErase(t *testing.T) {
	vault := &credentialVaultSpy{}
	server := newCredentialServer(t, vault)
	token := accessTokenFor(t, server)
	secret := "claude-oauth-secret"
	request := httptest.NewRequest(http.MethodPut,
		"/api/cloud/v1/orgs/"+orgOneID+"/provider-connections/agents/claude-code",
		bytes.NewBufferString(`{"credentialType":"oauth_token","secret":"`+secret+`"}`),
	)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("put status = %d: %s", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte(secret)) || bytes.Contains(response.Body.Bytes(), []byte("ciphertext")) {
		t.Fatalf("response exposed secret material: %s", response.Body.String())
	}
	if vault.seen.OrgID != orgOneID || vault.seen.UserID == "" {
		t.Fatalf("tenant = %#v", vault.seen)
	}
	if !allZeroHTTP(vault.secret) {
		t.Fatal("handler did not erase upload byte slice")
	}

	list := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/orgs/"+orgOneID+"/provider-connections", nil)
	list.Header.Set("Authorization", "Bearer "+token)
	listed := httptest.NewRecorder()
	server.Handler().ServeHTTP(listed, list)
	if listed.Code != http.StatusOK || bytes.Contains(listed.Body.Bytes(), []byte(secret)) {
		t.Fatalf("list status/body = %d %s", listed.Code, listed.Body.String())
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(listed.Body.Bytes(), &payload); err != nil || payload["providerConnections"] == nil {
		t.Fatalf("list payload = %s, err = %v", listed.Body.String(), err)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete,
		"/api/cloud/v1/orgs/"+orgOneID+"/provider-connections/agents/claude-code", nil)
	deleteRequest.Header.Set("Authorization", "Bearer "+token)
	deleted := httptest.NewRecorder()
	server.Handler().ServeHTTP(deleted, deleteRequest)
	if deleted.Code != http.StatusNoContent || vault.deleted != credentials.ProviderClaudeCode {
		t.Fatalf("delete = %d provider %q", deleted.Code, vault.deleted)
	}
}

func TestCredentialRoutesRejectUnauthenticatedAndCrossTenantBeforeVault(t *testing.T) {
	vault := &credentialVaultSpy{}
	server := newCredentialServer(t, vault)
	path := "/api/cloud/v1/orgs/" + orgOneID + "/provider-connections"
	unauthenticated := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, path, nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d", unauthenticated.Code)
	}

	foreign := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/orgs/"+orgTwoID+"/provider-connections", nil)
	foreign.Header.Set("Authorization", "Bearer "+accessTokenFor(t, server))
	foreignResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusForbidden || errorCode(t, foreignResponse) != "ORG_FORBIDDEN" {
		t.Fatalf("foreign = %d %s", foreignResponse.Code, foreignResponse.Body.String())
	}
	if vault.putCalls+vault.listCalls+vault.deleteCalls != 0 {
		t.Fatal("rejected request reached credential vault")
	}
}

func allZeroHTTP(value []byte) bool {
	for _, item := range value {
		if item != 0 {
			return false
		}
	}
	return true
}

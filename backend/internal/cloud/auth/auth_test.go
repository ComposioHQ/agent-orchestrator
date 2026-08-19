package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

func TestPasswordAndOpaqueToken(t *testing.T) {
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "correct horse battery staple") {
		t.Fatal("valid password was rejected")
	}
	if VerifyPassword(hash, "wrong password") {
		t.Fatal("invalid password was accepted")
	}
	token, tokenHash, err := NewOpaqueToken()
	if err != nil {
		t.Fatal(err)
	}
	if token == "" || len(tokenHash) != 32 {
		t.Fatalf("token=%q hash length=%d", token, len(tokenHash))
	}
	if got := HashToken(token); string(got) != string(tokenHash) {
		t.Fatal("token hash is not stable")
	}
}

func TestWorkOSProfileResolverFetchesAndCachesVerifiedProfile(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer sk_test" {
			t.Fatalf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"user_123",
			"email":"Person@Example.com",
			"first_name":"Person",
			"last_name":"Example"
		}`))
	}))
	defer server.Close()

	resolver, err := newWorkOSProfileResolver("sk_test", server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		email, displayName, err := resolver(context.Background(), "user_123")
		if err != nil {
			t.Fatal(err)
		}
		if email != "person@example.com" || displayName != "Person Example" {
			t.Fatalf("profile = %q, %q", email, displayName)
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d, want 1", requests.Load())
	}
}

func TestOIDCVerifierValidatesWorkOSToken(t *testing.T) {
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	const keyID = "workos-test-key"
	publicKey := jose.JSONWebKey{
		Key:       &privateKey.PublicKey,
		KeyID:     keyID,
		Algorithm: string(jose.RS256),
		Use:       "sig",
	}
	jwksServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{publicKey}})
	}))
	defer jwksServer.Close()

	signer, err := jose.NewSigner(
		jose.SigningKey{
			Algorithm: jose.RS256,
			Key: jose.JSONWebKey{
				Key:       privateKey,
				KeyID:     keyID,
				Algorithm: string(jose.RS256),
				Use:       "sig",
			},
		},
		(&jose.SignerOptions{}).WithType("JWT"),
	)
	if err != nil {
		t.Fatal(err)
	}
	const issuer = "https://api.workos.com/user_management/client_123"
	token, err := jwt.Signed(signer).
		Claims(jwt.Claims{
			Issuer:   issuer,
			Subject:  "user_123",
			IssuedAt: jwt.NewNumericDate(time.Now().Add(-time.Minute)),
			Expiry:   jwt.NewNumericDate(time.Now().Add(time.Hour)),
		}).
		Claims(map[string]any{
			"client_id": "client_123",
			"email":     "person@example.com",
			"name":      "Person Example",
			"org_id":    "org_123",
			"role":      "admin",
		}).
		Serialize()
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := NewOIDCVerifier(
		context.Background(),
		issuer,
		"client_123",
		jwksServer.URL,
		nil,
		func(_ context.Context, organizationID string) (string, error) {
			if organizationID != "org_123" {
				t.Fatalf("organization ID = %q", organizationID)
			}
			return "Example Inc.", nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	principal, err := verifier.Verify(context.Background(), token)
	if err != nil {
		t.Fatal(err)
	}
	if principal.ExternalID != "user_123" ||
		principal.Email != "person@example.com" ||
		principal.ExternalOrgID != "org_123" ||
		principal.OrgName != "Example Inc." ||
		principal.OrgRole != "admin" {
		t.Fatalf("principal = %#v", principal)
	}

	wrongClient, err := NewOIDCVerifier(
		context.Background(),
		issuer,
		"other_client",
		jwksServer.URL,
		nil,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wrongClient.Verify(context.Background(), token); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("wrong client ID error = %v", err)
	}
}

func TestWorkOSOrganizationResolverFetchesOrganization(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/organizations/org_123" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"id":"org_123","name":"Example Inc."}`))
	}))
	defer server.Close()
	resolver, err := newWorkOSOrganizationResolver("sk_test", server.URL, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	name, err := resolver(context.Background(), "org_123")
	if err != nil {
		t.Fatal(err)
	}
	if name != "Example Inc." {
		t.Fatalf("name = %q", name)
	}
}

func TestWorkOSCachesAreBounded(t *testing.T) {
	cache := make(map[string]int, maxWorkOSCacheEntries)
	for i := range maxWorkOSCacheEntries {
		cache[string(rune(i))] = i
	}
	trimCache(cache, func(int) bool { return false })
	if len(cache) != maxWorkOSCacheEntries-1 {
		t.Fatalf("cache length = %d", len(cache))
	}
}

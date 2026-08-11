package githubapp

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestClientUsesPKCEAndVerifiesUserInstallation(t *testing.T) {
	var exchange struct {
		CodeVerifier string `json:"code_verifier"`
		RedirectURI  string `json:"redirect_uri"`
	}
	membershipRole := "admin"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/oauth/access_token":
			if err := json.NewDecoder(r.Body).Decode(&exchange); err != nil {
				t.Error(err)
			}
			_, _ = w.Write([]byte(`{"access_token":"ephemeral-user-token"}`))
		case "/user/installations":
			if r.Header.Get("Authorization") != "Bearer ephemeral-user-token" {
				t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"installations":[{"id":123}]}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":789}`))
		case "/user/memberships/orgs/acme":
			_ = json.NewEncoder(w).Encode(map[string]string{
				"state": "active",
				"role":  membershipRole,
			})
		case "/app/installations/123":
			authorization := r.Header.Get("Authorization")
			if !strings.HasPrefix(authorization, "Bearer ") ||
				len(strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")) != 3 {
				t.Errorf("invalid GitHub App authorization: %q", authorization)
			}
			_, _ = w.Write([]byte(`{
				"id":123,
				"account":{"id":456,"login":"acme","type":"Organization"},
				"repository_selection":"selected",
				"permissions":{"contents":"read"},
				"events":["installation"]
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	oauthURL, err := url.Parse(client.OAuthURL("state-value", "challenge-value"))
	if err != nil {
		t.Fatal(err)
	}
	query := oauthURL.Query()
	if query.Get("state") != "state-value" ||
		query.Get("code_challenge") != "challenge-value" ||
		query.Get("code_challenge_method") != "S256" {
		t.Fatalf("OAuth query = %v", query)
	}
	token, err := client.ExchangeOAuthCode(
		context.Background(),
		"oauth-code",
		"pkce-verifier",
	)
	if err != nil {
		t.Fatal(err)
	}
	if token != "ephemeral-user-token" {
		t.Fatalf("token = %q", token)
	}
	if exchange.CodeVerifier != "pkce-verifier" ||
		exchange.RedirectURI != "https://api.aoagents.dev/api/cloud/v1/github/oauth/callback" {
		t.Fatalf("exchange = %#v", exchange)
	}
	authorized, err := client.UserHasInstallation(
		context.Background(),
		token,
		123,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !authorized {
		t.Fatal("verified user installation was not found")
	}
	installation, err := client.GetInstallation(context.Background(), 123)
	if err != nil {
		t.Fatal(err)
	}
	if installation.Account.Login != "acme" {
		t.Fatalf("installation = %#v", installation)
	}
	canAdminister, err := client.UserCanAdministerInstallation(
		context.Background(),
		token,
		installation,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !canAdminister {
		t.Fatal("active organization admin was rejected")
	}
	membershipRole = "member"
	canAdminister, err = client.UserCanAdministerInstallation(
		context.Background(),
		token,
		installation,
	)
	if err != nil {
		t.Fatal(err)
	}
	if canAdminister {
		t.Fatal("ordinary organization member was allowed to bind installation")
	}
	installation.Account.Type = "User"
	installation.Account.ID = 789
	canAdminister, err = client.UserCanAdministerInstallation(
		context.Background(),
		token,
		installation,
	)
	if err != nil || !canAdminister {
		t.Fatalf("personal installation owner rejected: allowed=%v err=%v", canAdminister, err)
	}
	installation.Account.ID = 790
	canAdminister, err = client.UserCanAdministerInstallation(
		context.Background(),
		token,
		installation,
	)
	if err != nil || canAdminister {
		t.Fatalf("different personal installation owner accepted: allowed=%v err=%v", canAdminister, err)
	}
}

func TestInstallationAuthorityProofRequiresMembersPermission(t *testing.T) {
	installation := Installation{
		Account:     InstallationOwner{Type: "Organization"},
		Permissions: map[string]string{"contents": "read"},
	}
	if InstallationSupportsAuthorityProof(installation) {
		t.Fatal("organization installation without members permission was accepted")
	}
	installation.Permissions["members"] = "read"
	if !InstallationSupportsAuthorityProof(installation) {
		t.Fatal("organization installation with members permission was rejected")
	}
	installation.Account.Type = "Enterprise"
	if InstallationSupportsAuthorityProof(installation) {
		t.Fatal("enterprise installation without authority proof was accepted")
	}
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKeyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
	})
	client, err := New(Config{
		AppID:         1234,
		AppSlug:       "ao-app",
		ClientID:      "client-id",
		ClientSecret:  "client-secret",
		PrivateKeyPEM: string(privateKeyPEM),
		PublicURL:     "https://api.aoagents.dev",
		APIBaseURL:    baseURL,
		WebBaseURL:    baseURL,
	}, serverClientWithoutRedirects())
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func serverClientWithoutRedirects() *http.Client {
	return &http.Client{
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

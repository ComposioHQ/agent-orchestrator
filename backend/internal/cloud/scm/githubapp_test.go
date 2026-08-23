package scm

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAppClientInstallationTokenRepositoriesAndOwnership(t *testing.T) {
	expiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/app/installations/55":
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
				t.Error("missing app JWT")
			}
			_, _ = io.WriteString(w, `{"id":55,"account":{"login":"Acme","type":"Organization"},"app_slug":"ao-cloud","repository_selection":"selected","suspended_at":null}`)
		case "/app/installations/55/access_tokens":
			var body struct {
				RepositoryIDs []int64           `json:"repository_ids"`
				Permissions   map[string]string `json:"permissions"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			token := "ghs_metadata"
			if len(body.RepositoryIDs) != 0 {
				token = "ghs_repository"
				if len(body.RepositoryIDs) != 1 || body.RepositoryIDs[0] != 77 || body.Permissions["contents"] != "read" {
					t.Errorf("mint body = %#v", body)
				}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"token": token, "expires_at": expiresAt})
		case "/installation/repositories":
			if r.Header.Get("Authorization") != "Bearer ghs_metadata" {
				t.Errorf("repository authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = io.WriteString(w, `{"repositories":[{"id":77,"full_name":"Acme/Widgets","private":true}]}`)
		case "/login/oauth/access_token":
			if err := r.ParseForm(); err != nil || r.Form.Get("client_id") != "client" || r.Form.Get("client_secret") != "secret" || r.Form.Get("code") != "code" {
				t.Errorf("oauth form = %#v error=%v", r.Form, err)
			}
			_, _ = io.WriteString(w, `{"access_token":"gho_user"}`)
		case "/user/installations":
			if r.Header.Get("Authorization") != "Bearer gho_user" {
				t.Errorf("user authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = io.WriteString(w, `{"installations":[{"id":55}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	credentials, err := NewAppCredentials(42, "ao-cloud", testRSAPrivateKeyPEM(t))
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAppClient(AppClientOptions{
		Credentials: credentials, HTTPClient: server.Client(),
		APIBase: server.URL, WebBase: server.URL,
		OAuthClientID: "client", OAuthClientSecret: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	account, err := client.Installation(t.Context(), 55)
	if err != nil || account.AccountLogin != "Acme" || account.ExternalID != 55 {
		t.Fatalf("account = %#v error=%v", account, err)
	}
	token, expiry, err := client.MintInstallationToken(t.Context(), 55, 77, map[string]string{"contents": "read", "metadata": "read"})
	if err != nil || string(token) != "ghs_repository" || !expiry.Equal(expiresAt) {
		t.Fatalf("token=%q expiry=%s error=%v", token, expiry, err)
	}
	repositories, err := client.ListInstallationRepositories(t.Context(), 55)
	if err != nil || len(repositories) != 1 || repositories[0].FullName != "acme/widgets" {
		t.Fatalf("repositories=%#v error=%v", repositories, err)
	}
	if err := client.VerifyUserInstallation(t.Context(), "code", 55); err != nil {
		t.Fatal(err)
	}
}

func TestAppClientRefusesCredentialBearingRedirects(t *testing.T) {
	var redirected atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected.Add(1)
	}))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusFound)
	}))
	defer source.Close()
	credentials, err := NewAppCredentials(42, "ao-cloud", testRSAPrivateKeyPEM(t))
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewAppClient(AppClientOptions{Credentials: credentials, HTTPClient: source.Client(), APIBase: source.URL, WebBase: source.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Installation(t.Context(), 55); err == nil {
		t.Fatal("redirect unexpectedly followed")
	}
	if redirected.Load() != 0 {
		t.Fatal("authorization-bearing redirect reached destination")
	}
}

func TestAppClientRejectsUnusableInstallationTokens(t *testing.T) {
	for _, testCase := range []struct{ name, response string }{
		{name: "empty", response: `{"token":"","expires_at":"2099-01-01T00:00:00Z"}`},
		{name: "expired", response: `{"token":"ghs_expired","expires_at":"2000-01-01T00:00:00Z"}`},
		{name: "escaped", response: `{"token":"ghs_bad\u0041","expires_at":"2099-01-01T00:00:00Z"}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/access_tokens") {
					http.NotFound(w, r)
					return
				}
				_, _ = io.WriteString(w, testCase.response)
			}))
			defer server.Close()
			credentials, err := NewAppCredentials(42, "ao-cloud", testRSAPrivateKeyPEM(t))
			if err != nil {
				t.Fatal(err)
			}
			client, err := NewAppClient(AppClientOptions{Credentials: credentials, HTTPClient: server.Client(), APIBase: server.URL})
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := client.MintInstallationToken(t.Context(), 55, 77, map[string]string{"contents": "read"}); err == nil {
				t.Fatal("unusable token was accepted")
			}
		})
	}
}

func TestGitHubAppSecretJSONFieldsAreMutableBytes(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "githubapp.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	ast.Inspect(file, func(node ast.Node) bool {
		field, ok := node.(*ast.Field)
		if !ok || field.Tag == nil {
			return true
		}
		tag := field.Tag.Value
		if !strings.Contains(tag, `json:"token"`) && !strings.Contains(tag, `json:"access_token"`) {
			return true
		}
		fieldType, ok := field.Type.(*ast.Ident)
		if !ok || fieldType.Name != "secretJSONBytes" {
			t.Errorf("secret JSON field %s must use secretJSONBytes", tag)
		}
		return true
	})
}

func TestAppClientRejectsUntrustedProviderBases(t *testing.T) {
	credentials, err := NewAppCredentials(42, "ao-cloud", testRSAPrivateKeyPEM(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, base := range []string{"http://evil.example", "https://user@api.github.com", "https://api.github.com?target=evil"} {
		if _, err := NewAppClient(AppClientOptions{Credentials: credentials, APIBase: base}); err == nil {
			t.Fatalf("accepted base %q", base)
		}
	}
}

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
	"time"
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
		case "/app":
			authorization := r.Header.Get("Authorization")
			if !strings.HasPrefix(authorization, "Bearer ") ||
				len(strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")) != 3 {
				t.Errorf("invalid GitHub App authorization: %q", authorization)
			}
			_, _ = w.Write([]byte(`{"id":1234,"slug":"ao-app"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	if err := client.Check(context.Background()); err != nil {
		t.Fatalf("check GitHub App: %v", err)
	}
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

func TestClientCheckRejectsUnexpectedAppIdentity(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"id":9999,"slug":"another-app"}`))
	}))
	defer server.Close()

	err := testClient(t, server.URL).Check(context.Background())
	if err == nil || !strings.Contains(err.Error(), "different App identity") {
		t.Fatalf("Check() error = %v", err)
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

func TestGitHubUserAuthorizationUsesPKCEAndRedactsRotatingTokens(t *testing.T) {
	var exchange map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/oauth/access_token":
			if err := json.NewDecoder(r.Body).Decode(&exchange); err != nil {
				t.Fatal(err)
			}
			_, _ = w.Write([]byte(`{
				"access_token":"access-secret",
				"expires_in":3600,
				"refresh_token":"refresh-secret",
				"refresh_token_expires_in":28800
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	authorizationURL, err := url.Parse(
		client.UserAuthorizationURL("state-value", "challenge-value"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if query := authorizationURL.Query(); query.Get("state") != "state-value" ||
		query.Get("code_challenge") != "challenge-value" ||
		query.Get("code_challenge_method") != "S256" ||
		query.Get("allow_signup") != "false" {
		t.Fatalf("authorization query = %v", query)
	}
	token, err := client.ExchangeUserCode(
		context.Background(),
		"authorization-code",
		"pkce-verifier",
	)
	if err != nil {
		t.Fatal(err)
	}
	if exchange["code_verifier"] != "pkce-verifier" ||
		exchange["redirect_uri"] != client.UserOAuthCallbackURL() {
		t.Fatalf("exchange = %#v", exchange)
	}
	if token.Token() != "access-secret" ||
		token.RefreshToken() != "refresh-secret" ||
		token.ExpiresAt == nil ||
		token.RefreshExpiresAt == nil {
		t.Fatalf("token metadata = %#v", token)
	}
	if strings.Contains(token.String(), "secret") ||
		strings.Contains(token.GoString(), "secret") {
		t.Fatal("formatted user token exposed a credential")
	}
}

func TestCreateRepositoryAsUserInitializesRequestedOwner(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/orgs/acme/repos" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer user-token" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(Repository{
			ID:            42,
			Name:          "scratch",
			FullName:      "acme/scratch",
			HTMLURL:       "https://github.com/acme/scratch",
			CloneURL:      "https://github.com/acme/scratch.git",
			DefaultBranch: "main",
			Owner:         RepositoryOwner{ID: 7, Login: "acme", Type: "Organization"},
			UpdatedAt:     time.Now().UTC(),
		})
	}))
	defer server.Close()

	repository, err := testClient(t, server.URL).CreateRepositoryAsUser(
		context.Background(),
		"user-token",
		"acme",
		"Organization",
		"scratch",
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if repository.FullName != "acme/scratch" ||
		requestBody["auto_init"] != true ||
		requestBody["private"] != true {
		t.Fatalf("repository = %#v request = %#v", repository, requestBody)
	}
}

func TestRepositoryWriteTokenRequestsContentsAndPullRequestsWrite(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app/installations/7/access_tokens" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(installationAccessToken{
			Token: "write-token", ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer server.Close()

	access, err := testClient(t, server.URL).repositoryWriteToken(context.Background(), 7, 9)
	if err != nil {
		t.Fatal(err)
	}
	if access.Token != "write-token" {
		t.Fatalf("token = %q", access.Token)
	}
	permissions, ok := requestBody["permissions"].(map[string]any)
	if !ok || permissions["contents"] != "write" || permissions["pull_requests"] != "write" {
		t.Fatalf("request permissions = %#v", requestBody["permissions"])
	}
	repositoryIDs, ok := requestBody["repository_ids"].([]any)
	if !ok || len(repositoryIDs) != 1 || repositoryIDs[0] != float64(9) {
		t.Fatalf("request repository_ids = %#v", requestBody["repository_ids"])
	}
}

func TestCreatePullRequestOpensAPullRequest(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/api/pulls" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer install-write-token" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		response := PullRequestResponse{
			ID: 100, Number: 42, HTMLURL: "https://github.com/acme/api/pull/42",
			State: "open", Title: "Fix the bug",
		}
		response.Head.SHA = "abc123"
		response.Head.Ref = "feat/fix-bug"
		response.Base.Ref = "main"
		_ = json.NewEncoder(w).Encode(response)
	}))
	defer server.Close()

	pr, err := testClient(t, server.URL).CreatePullRequest(
		context.Background(), "install-write-token", "acme", "api",
		CreatePullRequestInput{Title: "Fix the bug", Body: "Because reasons.", Head: "feat/fix-bug", Base: "main"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 42 || pr.HTMLURL != "https://github.com/acme/api/pull/42" || pr.Head.SHA != "abc123" {
		t.Fatalf("pull request = %#v", pr)
	}
	if requestBody["title"] != "Fix the bug" || requestBody["head"] != "feat/fix-bug" || requestBody["base"] != "main" {
		t.Fatalf("request body = %#v", requestBody)
	}
}

func TestStatusReadTokenRequestsPullRequestsAndChecksRead(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/app/installations/7/access_tokens" {
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(installationAccessToken{
			Token: "status-token", ExpiresAt: time.Now().UTC().Add(time.Hour),
		})
	}))
	defer server.Close()

	access, err := testClient(t, server.URL).statusReadToken(context.Background(), 7, 9)
	if err != nil {
		t.Fatal(err)
	}
	if access.Token != "status-token" {
		t.Fatalf("token = %q", access.Token)
	}
	permissions, ok := requestBody["permissions"].(map[string]any)
	if !ok || permissions["pull_requests"] != "read" || permissions["checks"] != "read" {
		t.Fatalf("request permissions = %#v", requestBody["permissions"])
	}
}

func TestGetPullRequestFetchesLifecycleAndMergeability(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/api/pulls/42" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer status-token" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		detail := PullRequestDetail{Number: 42, State: "open", MergeableState: "clean"}
		detail.Head.SHA = "abc123"
		_ = json.NewEncoder(w).Encode(detail)
	}))
	defer server.Close()

	detail, err := testClient(t, server.URL).GetPullRequest(context.Background(), "status-token", "acme", "api", 42)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Number != 42 || detail.State != "open" || detail.MergeableState != "clean" || detail.Head.SHA != "abc123" {
		t.Fatalf("detail = %#v", detail)
	}
}

func TestGetPullRequestRejectsAnIncompleteGitHubResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(PullRequestDetail{})
	}))
	defer server.Close()

	if _, err := testClient(t, server.URL).GetPullRequest(
		context.Background(), "status-token", "acme", "api", 42,
	); err == nil {
		t.Fatal("GetPullRequest() error = nil, want an error for a missing pull request number")
	}
}

func TestListCheckRunsFetchesEveryRunAgainstAReference(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/api/commits/abc123/check-runs" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"check_runs": []CheckRun{
				{Status: "completed", Conclusion: "success"},
				{Status: "in_progress"},
			},
		})
	}))
	defer server.Close()

	checks, err := testClient(t, server.URL).ListCheckRuns(context.Background(), "status-token", "acme", "api", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	if len(checks) != 2 || checks[0].Conclusion != "success" || checks[1].Status != "in_progress" {
		t.Fatalf("checks = %#v", checks)
	}
}

func TestListPullRequestReviewsFetchesEverySubmittedReview(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/api/pulls/42/reviews" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode([]PullRequestReview{
			{ID: 1, User: User{Login: "alice"}, State: "APPROVED"},
		})
	}))
	defer server.Close()

	reviews, err := testClient(t, server.URL).ListPullRequestReviews(context.Background(), "status-token", "acme", "api", 42)
	if err != nil {
		t.Fatal(err)
	}
	if len(reviews) != 1 || reviews[0].User.Login != "alice" || reviews[0].State != "APPROVED" {
		t.Fatalf("reviews = %#v", reviews)
	}
}

func TestCreatePullRequestReviewPostsACommentEvent(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/api/pulls/42/reviews" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer write-token" {
			t.Fatalf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": 555})
	}))
	defer server.Close()

	id, err := testClient(t, server.URL).CreatePullRequestReview(
		context.Background(), "write-token", "acme", "api", 42, "Looks good, one nit.",
	)
	if err != nil {
		t.Fatal(err)
	}
	if id != 555 {
		t.Fatalf("id = %d, want 555", id)
	}
	if requestBody["event"] != "COMMENT" || requestBody["body"] != "Looks good, one nit." {
		t.Fatalf("request body = %#v", requestBody)
	}
}

func TestCreatePullRequestReviewRequiresEveryField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("GitHub should not have been called with an incomplete request")
	}))
	defer server.Close()

	for _, tc := range []struct {
		name              string
		owner, repo, body string
		number            int
	}{
		{"missing owner", "", "api", "review body", 42},
		{"missing repo", "acme", "", "review body", 42},
		{"missing number", "acme", "api", "review body", 0},
		{"missing body", "acme", "api", "", 42},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := testClient(t, server.URL).CreatePullRequestReview(
				context.Background(), "token", tc.owner, tc.repo, tc.number, tc.body,
			); err == nil {
				t.Fatal("CreatePullRequestReview() error = nil, want a validation error")
			}
		})
	}
}

func TestCreatePullRequestRequiresEveryField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("GitHub should not have been called with an incomplete request")
	}))
	defer server.Close()

	for _, tc := range []struct {
		name  string
		input CreatePullRequestInput
	}{
		{"missing title", CreatePullRequestInput{Head: "feat/x", Base: "main"}},
		{"missing head", CreatePullRequestInput{Title: "x", Base: "main"}},
		{"missing base", CreatePullRequestInput{Title: "x", Head: "feat/x"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := testClient(t, server.URL).CreatePullRequest(
				context.Background(), "token", "acme", "api", tc.input,
			)
			if err == nil {
				t.Fatal("CreatePullRequest() error = nil, want an error for an incomplete input")
			}
		})
	}
}

func TestCreatePullRequestRejectsAnIncompleteGitHubResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// A response missing head.sha, as if GitHub's shape ever changed
		// underneath this client.
		_ = json.NewEncoder(w).Encode(PullRequestResponse{Number: 1, HTMLURL: "https://github.com/acme/api/pull/1"})
	}))
	defer server.Close()

	_, err := testClient(t, server.URL).CreatePullRequest(
		context.Background(), "token", "acme", "api",
		CreatePullRequestInput{Title: "x", Head: "feat/x", Base: "main"},
	)
	if err == nil {
		t.Fatal("CreatePullRequest() error = nil, want an error for an incomplete GitHub response")
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

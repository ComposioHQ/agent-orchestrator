package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

func TestCompletionHTMLUsesBrandedSuccessPage(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(true))
	for _, expected := range []string{
		"Agent Orchestrator",
		"brand-mark",
		"GitHub connected",
		"Close window",
		"window.close()",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("completion page does not contain %q", expected)
		}
	}
}

func TestCompletionHTMLUsesFailureStateWithoutAutoClose(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(false))
	if !strings.Contains(html, "Connection failed") {
		t.Fatal("failure page does not contain its heading")
	}
	if strings.Contains(html, "window.setTimeout") {
		t.Fatal("failure page closes before the user can read it")
	}
}

func TestInstallationCompletionHTMLClosesImmediately(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).InstallationCompletionHTML(true))
	if !strings.Contains(html, "window.close();") {
		t.Fatal("installation completion page does not close its popup")
	}
	if strings.Contains(html, "window.setTimeout") {
		t.Fatal("installation completion page waits before closing")
	}
}

type checkoutContextStore struct {
	Store
	authorization domain.GitHubCheckoutContext
}

func (s checkoutContextStore) WorkerGitHubCheckoutContext(
	context.Context, string, string,
) (domain.GitHubCheckoutContext, error) {
	return s.authorization, nil
}

func (s checkoutContextStore) CreatePullRequestRecord(
	_ context.Context,
	orgID, sessionID string,
	provider, repository, author string,
	number int,
	url, sourceBranch, targetBranch, headSHA, title string,
	additions, deletions, changedFiles int,
) (domain.PullRequest, error) {
	return domain.PullRequest{
		ID: "pr-record-1", OrgID: orgID, SessionID: sessionID,
		Provider: provider, Repository: repository, Author: author,
		Number: number, URL: url, SourceBranch: sourceBranch, TargetBranch: targetBranch,
		HeadSHA: headSHA, Title: title,
		Additions: additions, Deletions: deletions, ChangedFiles: changedFiles,
	}, nil
}

// CreateReviewRun stubs the review-trigger fan-out RaisePullRequest performs
// as a no-op (created=false) — RaisePullRequest's own tests assert on the
// pull request it recorded, not on review-triggering, which has its own
// dedicated tests.
func (s checkoutContextStore) CreateReviewRun(
	context.Context, string, string, string, string,
) (domain.ReviewRun, bool, error) {
	return domain.ReviewRun{}, false, nil
}

func (s checkoutContextStore) OpenReviewTerminal(context.Context, string, string, string, string) error {
	return nil
}

func (s checkoutContextStore) CloseReviewTerminal(context.Context, string, string, string) error {
	return nil
}

type userAuthorizationStore struct {
	Store
	attempt domain.GitHubUserAuthAttempt
	input   postgres.GitHubUserConnectionInput
}

type scratchRepositoryStore struct {
	Store
	connection domain.GitHubUserConnection
	reconciled int
	capability domain.GitHubRepositoryCapability
}

func (s *scratchRepositoryStore) GitHubUserConnection(
	_ context.Context,
	_ string,
) (domain.GitHubUserConnection, error) {
	return s.connection, nil
}

func (s *scratchRepositoryStore) BindGitHubInstallation(
	_ context.Context,
	_ domain.Principal,
	orgID string,
	installation domain.GitHubInstallation,
) (domain.GitHubInstallation, error) {
	installation.ID = "bound-installation"
	installation.OrgID = orgID
	return installation, nil
}

func (s *scratchRepositoryStore) BeginGitHubRepositorySync(
	_ context.Context,
	_ domain.GitHubInstallation,
) (int64, error) {
	return int64(s.reconciled + 1), nil
}

func (s *scratchRepositoryStore) ReconcileGitHubRepositories(
	_ context.Context,
	_ string,
	_ domain.GitHubInstallation,
	_ int64,
	_ []domain.GitHubRepository,
) error {
	s.reconciled++
	return nil
}

func (s *scratchRepositoryStore) ReserveGitHubRepositoryCapability(
	_ context.Context,
	principal domain.Principal,
	orgID, targetEnvironment, idempotencyKey string,
	requestHash []byte,
	githubInstallationID int64,
) (domain.GitHubRepositoryCapability, bool, error) {
	if s.capability.ID != "" {
		return s.capability, false, nil
	}
	s.capability = domain.GitHubRepositoryCapability{
		ID:                   "12345678-1234-1234-1234-123456789abc",
		OrgID:                orgID,
		UserID:               principal.UserID,
		UserExternalID:       principal.ExternalID,
		GitHubUserID:         s.connection.GitHubUserID,
		TargetEnvironment:    targetEnvironment,
		IdempotencyKey:       idempotencyKey,
		RequestHash:          append([]byte(nil), requestHash...),
		Status:               "creating",
		GitHubInstallationID: githubInstallationID,
	}
	return s.capability, true, nil
}

func (s *scratchRepositoryStore) ActivateGitHubRepositoryCapability(
	_ context.Context,
	principal domain.Principal,
	orgID, capabilityID string,
	repository domain.GitHubRepository,
	capabilityHash, ciphertext, nonce []byte,
) (domain.GitHubRepositoryCapability, error) {
	s.capability.Status = "active"
	s.capability.UserExternalID = principal.ExternalID
	s.capability.GitHubRepositoryID = repository.GitHubRepositoryID
	s.capability.Repository = repository
	s.capability.CapabilityHash = append([]byte(nil), capabilityHash...)
	s.capability.CapabilityCiphertext = append([]byte(nil), ciphertext...)
	s.capability.CapabilityNonce = append([]byte(nil), nonce...)
	s.capability.RepositoryOwner, _, _ = strings.Cut(repository.FullName, "/")
	s.capability.RepositoryName = repository.Name
	return s.capability, nil
}

func TestPrepareScratchRepositoryReturnsRollback(t *testing.T) {
	const accessToken = "user-token"
	created := false
	deleted := false
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/user/installations":
			_, _ = w.Write([]byte(`{"installations":[{
				"id":7,
				"account":{"id":8,"login":"acme","type":"Organization"},
				"repository_selection":"all",
				"permissions":{"administration":"write","contents":"write"}
			}]}`))
		case r.URL.Path == "/app/installations/7":
			_, _ = w.Write([]byte(`{
				"id":7,
				"account":{"id":8,"login":"acme","type":"Organization"},
				"repository_selection":"all",
				"permissions":{"administration":"write","contents":"write"}
			}`))
		case r.URL.Path == "/app/installations/7/access_tokens":
			_, _ = w.Write([]byte(`{"token":"installation-token","expires_at":"2030-01-01T00:00:00Z"}`))
		case r.URL.Path == "/installation/repositories":
			if !created {
				_, _ = w.Write([]byte(`{"repositories":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"repositories":[{
				"id":9,
				"name":"my-project",
				"full_name":"acme/my-project",
				"html_url":"https://github.com/acme/my-project",
				"clone_url":"https://github.com/acme/my-project.git",
				"default_branch":"main",
				"private":true,
				"visibility":"private",
				"owner":{"id":8,"login":"acme","type":"Organization"},
				"updated_at":"2026-08-12T00:00:00Z"
			}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/orgs/acme/repos":
			created = true
			_, _ = w.Write([]byte(`{
				"id":9,
				"name":"my-project",
				"full_name":"acme/my-project",
				"html_url":"https://github.com/acme/my-project",
				"clone_url":"https://github.com/acme/my-project.git",
				"default_branch":"main",
				"private":true,
				"visibility":"private",
				"owner":{"id":8,"login":"acme","type":"Organization"},
				"updated_at":"2026-08-12T00:00:00Z"
			}`))
		case r.Method == http.MethodDelete && r.URL.Path == "/repos/acme/my-project":
			deleted = true
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()

	credentialKey := bytes.Repeat([]byte{5}, 32)
	ciphertext, nonce, err := Encrypt(
		credentialKey,
		[]byte(accessToken),
		githubUserTokenAssociatedData("user-1", 42, "access"),
	)
	if err != nil {
		t.Fatal(err)
	}
	store := &scratchRepositoryStore{connection: domain.GitHubUserConnection{
		UserID:                "user-1",
		GitHubUserID:          42,
		AccessTokenCiphertext: ciphertext,
		AccessTokenNonce:      nonce,
	}}
	service, err := NewService(
		store,
		testClient(t, github.URL),
		bytes.Repeat([]byte{3}, 32),
		credentialKey,
		"webhook-secret",
		time.Minute,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	repository, cleanup, err := service.PrepareScratchRepository(
		context.Background(),
		domain.Principal{UserID: "user-1"},
		"org-1",
		7,
		"My Project",
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if repository.FullName != "acme/my-project" || cleanup == nil || store.reconciled != 2 {
		t.Fatalf("repository = %#v, reconciled = %d", repository, store.reconciled)
	}
	cleanup(context.Background())
	if !deleted || store.reconciled != 3 {
		t.Fatalf("deleted = %v, reconciled = %d", deleted, store.reconciled)
	}
}

func TestPrepareScratchCapabilityIsOpaqueAndIdempotent(t *testing.T) {
	const accessToken = "user-token"
	createCount := 0
	created := false
	github := httptest.NewServer(http.HandlerFunc(func(
		w http.ResponseWriter,
		r *http.Request,
	) {
		switch {
		case r.URL.Path == "/user/installations":
			_, _ = w.Write([]byte(`{"installations":[{
				"id":7,
				"account":{"id":8,"login":"acme","type":"Organization"},
				"repository_selection":"all",
				"permissions":{"administration":"write","contents":"write"}
			}]}`))
		case r.URL.Path == "/app/installations/7":
			_, _ = w.Write([]byte(`{
				"id":7,
				"account":{"id":8,"login":"acme","type":"Organization"},
				"repository_selection":"all",
				"permissions":{"administration":"write","contents":"write"}
			}`))
		case r.URL.Path == "/app/installations/7/access_tokens":
			_, _ = w.Write([]byte(`{"token":"installation-token","expires_at":"2030-01-01T00:00:00Z"}`))
		case r.URL.Path == "/installation/repositories":
			if !created {
				_, _ = w.Write([]byte(`{"repositories":[]}`))
				return
			}
			_, _ = w.Write([]byte(`{"repositories":[{
				"id":9,
				"name":"my-project-12345678",
				"full_name":"acme/my-project-12345678",
				"html_url":"https://github.com/acme/my-project-12345678",
				"clone_url":"https://github.com/acme/my-project-12345678.git",
				"default_branch":"main",
				"private":true,
				"visibility":"private",
				"owner":{"id":8,"login":"acme","type":"Organization"},
				"updated_at":"2026-08-12T00:00:00Z"
			}]}`))
		case r.Method == http.MethodGet &&
			r.URL.Path == "/repos/acme/my-project-12345678":
			if !created {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(`{
				"id":9,
				"name":"my-project-12345678",
				"full_name":"acme/my-project-12345678",
				"html_url":"https://github.com/acme/my-project-12345678",
				"clone_url":"https://github.com/acme/my-project-12345678.git",
				"default_branch":"main",
				"private":true,
				"visibility":"private",
				"owner":{"id":8,"login":"acme","type":"Organization"},
				"updated_at":"2026-08-12T00:00:00Z"
			}`))
		case r.Method == http.MethodPost && r.URL.Path == "/orgs/acme/repos":
			createCount++
			created = true
			_, _ = w.Write([]byte(`{
				"id":9,
				"name":"my-project-12345678",
				"full_name":"acme/my-project-12345678",
				"html_url":"https://github.com/acme/my-project-12345678",
				"clone_url":"https://github.com/acme/my-project-12345678.git",
				"default_branch":"main",
				"private":true,
				"visibility":"private",
				"owner":{"id":8,"login":"acme","type":"Organization"},
				"updated_at":"2026-08-12T00:00:00Z"
			}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()

	credentialKey := bytes.Repeat([]byte{5}, 32)
	ciphertext, nonce, err := Encrypt(
		credentialKey,
		[]byte(accessToken),
		githubUserTokenAssociatedData("user-1", 42, "access"),
	)
	if err != nil {
		t.Fatal(err)
	}
	store := &scratchRepositoryStore{connection: domain.GitHubUserConnection{
		UserID:                "user-1",
		GitHubUserID:          42,
		AccessTokenCiphertext: ciphertext,
		AccessTokenNonce:      nonce,
	}}
	service, err := NewService(
		store,
		testClient(t, github.URL),
		bytes.Repeat([]byte{3}, 32),
		credentialKey,
		"webhook-secret",
		time.Minute,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	principal := domain.Principal{
		UserID:     "user-1",
		ExternalID: "workos-user-1",
	}
	first, err := service.PrepareScratchCapability(
		context.Background(),
		principal,
		"org-1",
		"idempotency-key",
		"staging",
		7,
		"My Project",
		true,
		[]byte(`{"harness":"cursor"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.PrepareScratchCapability(
		context.Background(),
		principal,
		"org-1",
		"idempotency-key",
		"staging",
		7,
		"My Project",
		true,
		[]byte(`{"harness":"cursor"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	if first.Capability == "" ||
		len(first.Capability) < 40 ||
		first.Capability != second.Capability ||
		createCount != 1 {
		t.Fatalf(
			"capabilities equal=%v length=%d creates=%d",
			first.Capability == second.Capability,
			len(first.Capability),
			createCount,
		)
	}
	if strings.Contains(
		string(store.capability.CapabilityCiphertext),
		first.Capability,
	) {
		t.Fatal("plaintext capability was stored in ciphertext")
	}
}

func TestClaimUserInstallationVerifiesAdminAndSyncs(t *testing.T) {
	const accessToken = "user-token"
	github := httptest.NewServer(http.HandlerFunc(func(
		w http.ResponseWriter,
		r *http.Request,
	) {
		switch r.URL.Path {
		case "/user/installations":
			if r.Header.Get("Authorization") != "Bearer "+accessToken {
				t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
			}
			_, _ = w.Write([]byte(`{"installations":[{"id":7}]}`))
		case "/app/installations/7":
			_, _ = w.Write([]byte(`{
				"id":7,
				"account":{"id":8,"login":"acme","type":"Organization"},
				"repository_selection":"all",
				"permissions":{"members":"read","contents":"write"}
			}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":42}`))
		case "/user/memberships/orgs/acme":
			_, _ = w.Write([]byte(`{"state":"active","role":"admin"}`))
		case "/app/installations/7/access_tokens":
			_, _ = w.Write([]byte(`{
				"token":"installation-token",
				"expires_at":"2026-08-14T23:00:00Z"
			}`))
		case "/installation/repositories":
			_, _ = w.Write([]byte(`{"repositories":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()

	credentialKey := bytes.Repeat([]byte{5}, 32)
	ciphertext, nonce, err := Encrypt(
		credentialKey,
		[]byte(accessToken),
		githubUserTokenAssociatedData("user-1", 42, "access"),
	)
	if err != nil {
		t.Fatal(err)
	}
	store := &scratchRepositoryStore{connection: domain.GitHubUserConnection{
		UserID:                "user-1",
		GitHubUserID:          42,
		AccessTokenCiphertext: ciphertext,
		AccessTokenNonce:      nonce,
	}}
	service, err := NewService(
		store,
		testClient(t, github.URL),
		bytes.Repeat([]byte{3}, 32),
		credentialKey,
		"webhook-secret",
		time.Minute,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.ClaimUserInstallation(
		context.Background(),
		domain.Principal{UserID: "user-1"},
		"org-1",
		7,
	)
	if err != nil {
		t.Fatal(err)
	}
	if installation.ID != "bound-installation" ||
		installation.OrgID != "org-1" ||
		installation.SyncStatus != "ready" ||
		store.reconciled != 1 {
		t.Fatalf("installation = %#v, reconciled = %d", installation, store.reconciled)
	}
}

func (s *userAuthorizationStore) CreateGitHubUserAuthAttempt(
	_ context.Context,
	userID string,
	stateHash, verifierCiphertext, verifierNonce []byte,
	expiresAt time.Time,
) (domain.GitHubUserAuthAttempt, error) {
	s.attempt = domain.GitHubUserAuthAttempt{
		ID:                     "attempt",
		UserID:                 userID,
		StateHash:              append([]byte(nil), stateHash...),
		CodeVerifierCiphertext: append([]byte(nil), verifierCiphertext...),
		CodeVerifierNonce:      append([]byte(nil), verifierNonce...),
		ExpiresAt:              expiresAt,
	}
	return s.attempt, nil
}

func (s *userAuthorizationStore) GitHubUserAuthAttempt(
	_ context.Context,
	stateHash []byte,
) (domain.GitHubUserAuthAttempt, error) {
	if !bytes.Equal(stateHash, s.attempt.StateHash) {
		return domain.GitHubUserAuthAttempt{}, postgres.ErrNotFound
	}
	return s.attempt, nil
}

func (s *userAuthorizationStore) CompleteGitHubUserAuthorization(
	_ context.Context,
	stateHash []byte,
	input postgres.GitHubUserConnectionInput,
) (domain.GitHubUserConnection, error) {
	if !bytes.Equal(stateHash, s.attempt.StateHash) {
		return domain.GitHubUserConnection{}, postgres.ErrNotFound
	}
	s.input = input
	return domain.GitHubUserConnection{
		UserID:       s.attempt.UserID,
		GitHubUserID: input.GitHubUserID,
		GitHubLogin:  input.GitHubLogin,
	}, nil
}

func TestUserAuthorizationEncryptsPKCEAndDurableCredentials(t *testing.T) {
	const accessToken = "github-user-access-secret"
	const refreshToken = "github-user-refresh-secret"
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/login/oauth/access_token":
			_, _ = w.Write([]byte(`{
				"access_token":"` + accessToken + `",
				"expires_in":3600,
				"refresh_token":"` + refreshToken + `",
				"refresh_token_expires_in":28800
			}`))
		case "/user":
			_, _ = w.Write([]byte(`{"id":42,"login":"octocat"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()

	store := &userAuthorizationStore{}
	credentialKey := bytes.Repeat([]byte{7}, 32)
	service, err := NewService(
		store,
		testClient(t, github.URL),
		bytes.Repeat([]byte{3}, 32),
		credentialKey,
		"webhook-secret",
		time.Minute,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	authorizeURL, _, err := service.StartUserAuthorization(
		context.Background(),
		domain.Principal{UserID: "user-1"},
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(authorizeURL)
	if err != nil {
		t.Fatal(err)
	}
	state := parsed.Query().Get("state")
	if state == "" || parsed.Query().Get("code_challenge") == "" {
		t.Fatalf("authorize URL = %s", authorizeURL)
	}
	if bytes.Contains(store.attempt.CodeVerifierCiphertext, []byte(parsed.Query().Get("code_challenge"))) {
		t.Fatal("PKCE material was stored in plaintext")
	}
	if _, err := service.CompleteUserAuthorization(
		context.Background(),
		state,
		"authorization-code",
	); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(store.input.AccessTokenCiphertext, []byte(accessToken)) ||
		bytes.Contains(store.input.RefreshTokenCiphertext, []byte(refreshToken)) {
		t.Fatal("GitHub user credential was stored in plaintext")
	}
	plaintext, err := Decrypt(
		credentialKey,
		store.input.AccessTokenCiphertext,
		store.input.AccessTokenNonce,
		githubUserTokenAssociatedData("user-1", 42, "access"),
	)
	if err != nil || string(plaintext) != accessToken {
		t.Fatalf("decrypt access credential = %q, %v", plaintext, err)
	}
}

func TestIssueCheckoutGrantScopesTokenAfterAuthorization(t *testing.T) {
	const token = "short-lived-installation-secret"
	var body map[string]any
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": token, "expires_at": time.Now().UTC().Add(time.Hour),
		})
	}))
	defer github.Close()
	var logs bytes.Buffer
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/acme/api.git",
		}},
		testClient(t, github.URL), make([]byte, 32), make([]byte, 32), "webhook-secret",
		time.Minute, slog.New(slog.NewJSONHandler(&logs, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := service.IssueCheckoutGrant(context.Background(), "org", "session")
	if err != nil {
		t.Fatal(err)
	}
	ids, idsOK := body["repository_ids"].([]any)
	permissions, permissionsOK := body["permissions"].(map[string]any)
	if grant.Token != token || grant.CloneURL != "https://github.com/acme/api.git" ||
		!idsOK || len(ids) != 1 || ids[0] != float64(456) ||
		!permissionsOK || permissions["contents"] != "read" ||
		requests != 1 {
		t.Fatalf("grant = %#v, request = %#v", grant, body)
	}
	if strings.Contains(logs.String(), token) {
		t.Fatal("installation token entered service logs")
	}
}

func TestIssueCheckoutGrantRejectsIdentityMismatchBeforeIssuance(t *testing.T) {
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer github.Close()
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/other/repo.git",
		}},
		testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.IssueCheckoutGrant(context.Background(), "org", "session"); err != postgres.ErrForbidden {
		t.Fatalf("error = %v, want forbidden", err)
	}
	if requests != 0 {
		t.Fatalf("GitHub token requests = %d, want 0", requests)
	}
}

func TestIssuePushGrantRequestsWriteScopedToken(t *testing.T) {
	var body map[string]any
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "write-secret", "expires_at": time.Now().UTC().Add(time.Hour),
		})
	}))
	defer github.Close()
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/acme/api.git",
		}},
		testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := service.IssuePushGrant(context.Background(), "org", "session")
	if err != nil {
		t.Fatal(err)
	}
	permissions, ok := body["permissions"].(map[string]any)
	if grant.Token != "write-secret" ||
		!ok || permissions["contents"] != "write" || permissions["pull_requests"] != "write" {
		t.Fatalf("grant = %#v, request permissions = %#v", grant, body["permissions"])
	}
}

func TestRaisePullRequestOpensAndRecordsAPullRequest(t *testing.T) {
	var tokenRequests, pullRequests int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/access_tokens"):
			tokenRequests++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "write-secret", "expires_at": time.Now().UTC().Add(time.Hour),
			})
		case r.URL.Path == "/repos/acme/api/pulls":
			pullRequests++
			if r.Header.Get("Authorization") != "Bearer write-secret" {
				t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
			}
			response := PullRequestResponse{
				Number: 7, HTMLURL: "https://github.com/acme/api/pull/7",
			}
			response.Head.SHA = "deadbeef"
			_ = json.NewEncoder(w).Encode(response)
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/acme/api.git",
			DefaultBranch: "main",
		}},
		testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	pr, err := service.RaisePullRequest(context.Background(), "org", "session", domain.RaisePullRequest{
		Title: "Fix the thing", Body: "Because it was broken.", HeadBranch: "feat/fix",
	})
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 7 || pr.URL != "https://github.com/acme/api/pull/7" ||
		pr.TargetBranch != "main" || pr.SourceBranch != "feat/fix" || pr.HeadSHA != "deadbeef" ||
		tokenRequests != 1 || pullRequests != 1 {
		t.Fatalf("pull request = %#v, token requests = %d, pull requests = %d", pr, tokenRequests, pullRequests)
	}
}

func TestRaisePullRequestFailsClosedWithNoBaseBranchAvailable(t *testing.T) {
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer github.Close()
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/acme/api.git",
			DefaultBranch: "",
		}},
		testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RaisePullRequest(context.Background(), "org", "session", domain.RaisePullRequest{
		Title: "Fix the thing", HeadBranch: "feat/fix",
	})
	if err == nil {
		t.Fatal("RaisePullRequest() error = nil, want an error with no base branch given or on record")
	}
	if requests != 0 {
		t.Fatalf("GitHub requests = %d, want 0", requests)
	}
}

type pullRequestStatusStore struct {
	Store
	installationID, repositoryID int64
	resolveErr                   error
	observation                  domain.PullRequestObservation
	observed                     bool
}

func (s *pullRequestStatusStore) GitHubInstallationForRepository(
	_ context.Context, _, _ string,
) (int64, int64, error) {
	if s.resolveErr != nil {
		return 0, 0, s.resolveErr
	}
	return s.installationID, s.repositoryID, nil
}

func (s *pullRequestStatusStore) UpdatePullRequestObservation(
	_ context.Context, orgID, pullRequestID string, observation domain.PullRequestObservation,
) (domain.PullRequest, error) {
	s.observed = true
	s.observation = observation
	return domain.PullRequest{ID: pullRequestID, OrgID: orgID, State: observation.State}, nil
}

func TestRefreshPullRequestStatusFetchesAndAppliesGitHubState(t *testing.T) {
	var tokenRequests int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/access_tokens"):
			tokenRequests++
			permissions := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&struct {
				Permissions *map[string]any `json:"permissions"`
			}{Permissions: &permissions})
			if permissions["pull_requests"] != "read" || permissions["checks"] != "read" {
				t.Errorf("token permissions = %#v", permissions)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "status-token", "expires_at": time.Now().UTC().Add(time.Hour),
			})
		case r.URL.Path == "/repos/acme/api/pulls/42":
			detail := PullRequestDetail{Number: 42, State: "open", MergeableState: "clean"}
			detail.Head.SHA = "deadbeef"
			_ = json.NewEncoder(w).Encode(detail)
		case r.URL.Path == "/repos/acme/api/commits/deadbeef/check-runs":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"check_runs": []CheckRun{{Status: "completed", Conclusion: "success"}},
			})
		case r.URL.Path == "/repos/acme/api/pulls/42/reviews":
			_ = json.NewEncoder(w).Encode([]PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "APPROVED"},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	store := &pullRequestStatusStore{installationID: 123, repositoryID: 456}
	service, err := NewService(
		store, testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	pr, err := service.RefreshPullRequestStatus(context.Background(), domain.PullRequestRef{
		ID: "pr-1", OrgID: "org", Provider: "github", Repository: "acme/api", Number: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !store.observed || pr.ID != "pr-1" || tokenRequests != 1 {
		t.Fatalf("pr = %#v, observed = %v, token requests = %d", pr, store.observed, tokenRequests)
	}
	if store.observation.State != contract.PRStateOpen || store.observation.HeadSHA != "deadbeef" ||
		store.observation.CIState != contract.CIPassing || store.observation.ReviewState != contract.ReviewApproved ||
		store.observation.Mergeability != contract.MergeMergeable {
		t.Fatalf("observation = %#v", store.observation)
	}
}

func TestRefreshPullRequestStatusFailsClosedWithoutAnActiveInstallation(t *testing.T) {
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer github.Close()
	store := &pullRequestStatusStore{resolveErr: postgres.ErrNotFound}
	service, err := NewService(
		store, testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.RefreshPullRequestStatus(context.Background(), domain.PullRequestRef{
		ID: "pr-1", OrgID: "org", Provider: "github", Repository: "acme/api", Number: 42,
	})
	if err == nil {
		t.Fatal("RefreshPullRequestStatus() error = nil, want an error with no active installation")
	}
	if requests != 0 {
		t.Fatalf("GitHub requests = %d, want 0", requests)
	}
}

type reviewTriggerStore struct {
	Store
	createdRun    domain.ReviewRun
	created       bool
	createErr     error
	sawCreateArgs [4]string
	queuedPrompt  string
	queueErr      error
	sawQueueCall  bool
}

func (s *reviewTriggerStore) CreateReviewRun(
	_ context.Context, orgID, pullRequestID, reviewSessionID, targetSHA string,
) (domain.ReviewRun, bool, error) {
	s.sawCreateArgs = [4]string{orgID, pullRequestID, reviewSessionID, targetSHA}
	if s.createErr != nil {
		return domain.ReviewRun{}, false, s.createErr
	}
	return s.createdRun, s.created, nil
}

func (s *reviewTriggerStore) OpenReviewTerminal(_ context.Context, _, _, _, prompt string) error {
	s.sawQueueCall = true
	s.queuedPrompt = prompt
	return s.queueErr
}

func TestTriggerReviewQueuesAPromptOnlyWhenARunIsNewlyCreated(t *testing.T) {
	store := &reviewTriggerStore{
		createdRun: domain.ReviewRun{ID: "run-1"}, created: true,
	}
	service, err := NewService(
		store, testClient(t, "https://example.invalid"), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	service.triggerReview(context.Background(), "org", "session", domain.PullRequest{
		ID: "pr-1", Repository: "acme/api", Number: 7, Title: "Fix the thing",
		SourceBranch: "feat/fix", TargetBranch: "main", HeadSHA: "deadbeef",
	})
	if store.sawCreateArgs != [4]string{"org", "pr-1", "session", "deadbeef"} {
		t.Fatalf("CreateReviewRun args = %v", store.sawCreateArgs)
	}
	if !store.sawQueueCall || !strings.Contains(store.queuedPrompt, "run-1") ||
		!strings.Contains(store.queuedPrompt, "acme/api") || !strings.Contains(store.queuedPrompt, "#7") {
		t.Fatalf("queued prompt = %q, sawQueueCall = %v", store.queuedPrompt, store.sawQueueCall)
	}
}

func TestTriggerReviewSkipsQueueingWhenARunAlreadyExists(t *testing.T) {
	store := &reviewTriggerStore{created: false}
	service, err := NewService(
		store, testClient(t, "https://example.invalid"), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	service.triggerReview(context.Background(), "org", "session", domain.PullRequest{
		ID: "pr-1", Repository: "acme/api", Number: 7, HeadSHA: "deadbeef",
	})
	if store.sawQueueCall {
		t.Fatal("OpenReviewTerminal was called for an already-existing review run")
	}
}

type reviewSubmissionStore struct {
	Store
	run              domain.ReviewRunPullRequest
	runErr           error
	installationID   int64
	repositoryID     int64
	resolveErr       error
	deliveredVerdict domain.SubmitReviewResult
	deliveredID      string
	sawDeliver       bool
	failedError      string
	sawFail          bool
	sawCloseTerminal bool
}

func (s *reviewSubmissionStore) CloseReviewTerminal(context.Context, string, string, string) error {
	s.sawCloseTerminal = true
	return nil
}

func (s *reviewSubmissionStore) ReviewRunPullRequest(
	context.Context, string, string,
) (domain.ReviewRunPullRequest, error) {
	if s.runErr != nil {
		return domain.ReviewRunPullRequest{}, s.runErr
	}
	return s.run, nil
}

func (s *reviewSubmissionStore) GitHubInstallationForRepository(
	context.Context, string, string,
) (int64, int64, error) {
	if s.resolveErr != nil {
		return 0, 0, s.resolveErr
	}
	return s.installationID, s.repositoryID, nil
}

func (s *reviewSubmissionStore) CompleteAndDeliverReviewRun(
	_ context.Context, _, _, _ string, result domain.SubmitReviewResult, providerReviewID string,
) (domain.ReviewRun, error) {
	s.sawDeliver = true
	s.deliveredVerdict = result
	s.deliveredID = providerReviewID
	return domain.ReviewRun{ID: "run-1", Status: contract.AOReviewRunDelivered, Verdict: result.Verdict}, nil
}

func (s *reviewSubmissionStore) FailReviewRun(
	_ context.Context, _, _, _, lastError string,
) (domain.ReviewRun, error) {
	s.sawFail = true
	s.failedError = lastError
	return domain.ReviewRun{ID: "run-1", Status: contract.AOReviewRunFailed}, nil
}

func TestSubmitReviewPostsToGitHubAndDelivers(t *testing.T) {
	var reviewRequests int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/access_tokens"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "write-token", "expires_at": time.Now().UTC().Add(time.Hour),
			})
		case r.URL.Path == "/repos/acme/api/pulls/7/reviews":
			reviewRequests++
			_ = json.NewEncoder(w).Encode(map[string]any{"id": 999})
		default:
			http.NotFound(w, r)
		}
	}))
	defer github.Close()
	store := &reviewSubmissionStore{
		run: domain.ReviewRunPullRequest{
			ReviewRun: domain.ReviewRun{
				ID: "run-1", ReviewSessionID: "session", Status: contract.AOReviewRunRunning,
			},
			PullRequestProvider: "github", PullRequestRepository: "acme/api", PullRequestNumber: 7,
		},
		installationID: 123, repositoryID: 456,
	}
	service, err := NewService(
		store, testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	run, err := service.SubmitReview(context.Background(), "org", "session", "run-1", domain.SubmitReviewResult{
		Verdict: contract.AOReviewVerdictApproved, Body: "Looks good.",
	})
	if err != nil {
		t.Fatal(err)
	}
	if reviewRequests != 1 || !store.sawDeliver || store.deliveredID != "999" || !store.sawCloseTerminal ||
		store.deliveredVerdict.Verdict != contract.AOReviewVerdictApproved || run.Status != contract.AOReviewRunDelivered {
		t.Fatalf("run = %#v, reviewRequests = %d, store = %#v", run, reviewRequests, store)
	}
}

func TestSubmitReviewRejectsAnInvalidVerdict(t *testing.T) {
	store := &reviewSubmissionStore{}
	service, err := NewService(
		store, testClient(t, "https://example.invalid"), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SubmitReview(context.Background(), "org", "session", "run-1", domain.SubmitReviewResult{
		Verdict: "not-a-real-verdict", Body: "Looks good.",
	}); !errors.Is(err, postgres.ErrInvalid) {
		t.Fatalf("error = %v, want ErrInvalid", err)
	}
}

func TestSubmitReviewFailsClosedForAnotherSessionsReviewRun(t *testing.T) {
	store := &reviewSubmissionStore{
		run: domain.ReviewRunPullRequest{
			ReviewRun: domain.ReviewRun{ID: "run-1", ReviewSessionID: "other-session", Status: contract.AOReviewRunRunning},
		},
	}
	service, err := NewService(
		store, testClient(t, "https://example.invalid"), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SubmitReview(context.Background(), "org", "session", "run-1", domain.SubmitReviewResult{
		Verdict: contract.AOReviewVerdictApproved, Body: "Looks good.",
	}); !errors.Is(err, postgres.ErrForbidden) {
		t.Fatalf("error = %v, want ErrForbidden", err)
	}
}

func TestSubmitReviewMarksTheRunFailedWhenGitHubRejectsIt(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/access_tokens") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"token": "write-token", "expires_at": time.Now().UTC().Add(time.Hour),
			})
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer github.Close()
	store := &reviewSubmissionStore{
		run: domain.ReviewRunPullRequest{
			ReviewRun: domain.ReviewRun{
				ID: "run-1", ReviewSessionID: "session", Status: contract.AOReviewRunRunning,
			},
			PullRequestProvider: "github", PullRequestRepository: "acme/api", PullRequestNumber: 7,
		},
		installationID: 123, repositoryID: 456,
	}
	service, err := NewService(
		store, testClient(t, github.URL), make([]byte, 32), make([]byte, 32),
		"webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	run, err := service.SubmitReview(context.Background(), "org", "session", "run-1", domain.SubmitReviewResult{
		Verdict: contract.AOReviewVerdictApproved, Body: "Looks good.",
	})
	if err == nil {
		t.Fatal("SubmitReview() error = nil, want the GitHub failure surfaced")
	}
	if !store.sawFail || !store.sawCloseTerminal || run.Status != contract.AOReviewRunFailed {
		t.Fatalf("run = %#v, sawFail = %v, sawCloseTerminal = %v", run, store.sawFail, store.sawCloseTerminal)
	}
}

package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
)

func TestCompletionHTMLUsesBrandedSuccessPage(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(true))
	for _, expected := range []string{
		"Agent Orchestrator",
		"https://aoagents.dev/ao-logo.svg",
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

type checkoutContextStore struct {
	Store
	authorization domain.GitHubCheckoutContext
}

func (s checkoutContextStore) WorkerGitHubCheckoutContext(
	context.Context, string, string,
) (domain.GitHubCheckoutContext, error) {
	return s.authorization, nil
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
